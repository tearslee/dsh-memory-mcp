/**
 * 独立运行验证：**不开 DSH**，MCP 服务能否自己拉起向量后端并完成语义检索。
 *
 * 前提由调用方保证：此刻没有任何 llama-server 在跑（8199 空闲），
 * 即模拟「DSH 未启动、也没有任何外部向量服务」的全新开机状态。
 * 前置不满足时**不报 FAIL**，而是把依赖它的几节标成「跳过」并在汇总里数出来 ——
 * 环境不对不该伪装成代码回归（旧版硬断言会在别人的机器上稳定误报）。
 *
 * 两项配置都**只从环境变量读，绝不写死本机路径**：
 *   DSH_MEMORY_EMBED_EXE / DSH_MEMORY_EMBED_MODEL   向量后端可执行文件与模型
 *       （或 DSH_MEMORY_EMBED_ENDPOINT 指向一个已在运行的服务）
 *       没配 ⇒ 打印提示，「自拉起后端」与「语义召回」两节跳过（不会拿假路径硬跑）。
 *   DSH_MEMORY_REAL_STORE                            要验的真实记忆库
 *       没配 ⇒ 打印提示并 exit 0 跳过（可选验收，"没配"不算失败）。
 *
 * 用法：DSH_MEMORY_REAL_STORE=<dir> node scripts/acceptance-standalone.mjs [--keep]
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// 服务入口从**本文件位置**推导：scripts/ 的上一级就是仓库根。
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const ENTRY = join(ROOT, 'src', 'index.js')
const KEEP = process.argv.includes('--keep')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
let skipped = 0
function check(ok, label, extra = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${label}${extra ? `  ${extra}` : ''}`)
  } else {
    fail++
    console.log(`  ✗ FAIL  ${label}${extra ? `  ${extra}` : ''}`)
  }
}
/** 跳过不计入失败：这些检查依赖"本机/环境恰好具备某条件"。 */
function skip(label, reason = '') {
  skipped++
  console.log(`  ─ 跳过  ${label}${reason ? `  (${reason})` : ''}`)
}

// ── 跨平台探活：node:net 连一下，不用 netstat / findstr ────────────
/**
 * 127.0.0.1:<port> 是否可连。超时或拒连都算"没在监听"。
 * @returns {Promise<boolean>}
 */
function listeningOn(port, timeoutMs = 800) {
  return new Promise((done) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      socket.destroy()
      done(result)
    }
    const socket = connect({ port, host: '127.0.0.1' })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/** llama-server 的 /health 用 fetch 探，不依赖外部 curl。 */
async function embedHealth(baseUrl, timeoutMs = 3000) {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return false
    const json = await res.json().catch(() => null)
    return json?.status === 'ok' || json?.status === undefined
  } catch {
    return false
  }
}

// ── 配置：只认环境变量 ──────────────────────────────────────────
const EMBED_EXE = (process.env.DSH_MEMORY_EMBED_EXE ?? '').trim()
const EMBED_MODEL = (process.env.DSH_MEMORY_EMBED_MODEL ?? '').trim()
const EMBED_ENDPOINT = (process.env.DSH_MEMORY_EMBED_ENDPOINT ?? '').trim()
const EMBED_PORT = Number.parseInt(process.env.DSH_MEMORY_EMBED_PORT ?? '', 10) || 8199
/** DSH 插件自己的向量服务端口 —— 本脚本必须证明没去动它。 */
const DSH_PORT = 8078
const REAL_STORE_RAW = (process.env.DSH_MEMORY_REAL_STORE ?? '').trim()
const REAL_STORE = REAL_STORE_RAW === '' ? null : resolve(REAL_STORE_RAW)

/** 外部端点模式：只连不启，永不 spawn。 */
const EXTERNAL = EMBED_ENDPOINT !== ''
/** 有可用后端配置 = 外部端点，或 exe+model 都给全。 */
const EMBED_CONFIGURED = EXTERNAL || (EMBED_EXE !== '' && EMBED_MODEL !== '')
const BASE_URL = EXTERNAL
  ? (() => {
    try {
      return new URL(EMBED_ENDPOINT).origin
    } catch {
      return EMBED_ENDPOINT.replace(/\/+$/u, '').replace(/\/v1\/embeddings$/iu, '')
    }
  })()
  : `http://127.0.0.1:${EMBED_PORT}`

// ── 前置:没配真实库就跳过(exit 0) ─────────────────────────────
if (REAL_STORE === null) {
  console.log('\n=== 独立运行验证：完全不开 DSH ===')
  console.log('')
  console.log('⚠️  未配置 DSH_MEMORY_REAL_STORE，本脚本跳过（退出码 0）。')
  console.log('    这是**可选**验收：它要在「DSH 未启动」的状态下读写**你的**记忆库，')
  console.log('    所以目标库必须由你显式指定 —— 脚本不会猜路径，也不会挑一个目录冒充真实库。')
  console.log('')
  console.log('    PowerShell:  $env:DSH_MEMORY_REAL_STORE = "D:\\dev\\.dsh-memory-store"; node scripts/acceptance-standalone.mjs')
  console.log('    bash / zsh :  DSH_MEMORY_REAL_STORE=~/.dsh-memory-store node scripts/acceptance-standalone.mjs')
  console.log('')
  console.log('    ⇒ 只想先确认脚本自身跑得通？指向一个临时目录即可（不会碰你的真实库）：')
  console.log('      PowerShell:  $env:DSH_MEMORY_REAL_STORE = Join-Path $env:TEMP "dsh-store-dryrun"')
  console.log('')
  process.exit(0)
}

console.log('\n=== 独立运行验证：完全不开 DSH ===')
console.log(`服务入口   : ${ENTRY}`)
console.log(`真实 store : ${REAL_STORE}`)
if (EXTERNAL) console.log(`向量后端   : 外部端点 ${BASE_URL}（只连不启）`)
else if (EMBED_CONFIGURED) console.log(`向量后端   : 自拉起 ${EMBED_EXE}（端口 ${EMBED_PORT}）`)
else console.log('向量后端   : 未配置')
console.log('')

const dshBusyBefore = await listeningOn(DSH_PORT)
const ownBusyBefore = await listeningOn(EXTERNAL ? DSH_PORT : EMBED_PORT)
const spawning = EMBED_CONFIGURED && !EXTERNAL && !ownBusyBefore
console.log(`前置：${DSH_PORT} 空闲=${!dshBusyBefore}，${EMBED_PORT} 空闲=${!ownBusyBefore}`)
if (!EMBED_CONFIGURED) {
  console.log('⚠️  本机没配向量后端：DSH_MEMORY_EMBED_EXE / DSH_MEMORY_EMBED_MODEL 均为空。')
  console.log('    ⇒ 本脚本的「自拉起后端」与「语义召回」两节将跳过；其余检查照常。')
  console.log('    ⇒ 后端已跑起来的话，也可以只设 DSH_MEMORY_EMBED_ENDPOINT=http://127.0.0.1:<端口> 复用。')
} else if (!spawning && !EXTERNAL) {
  console.log(`⚠️  ${EMBED_PORT} 已有服务在监听：本次会**复用**它，所以「MCP 自己拉起」那几项跳过。`)
  console.log('    ⇒ 要验证冷启动自拉起，先停掉该端口上的 llama-server。')
}
console.log('')

const project = mkdtempSync(join(tmpdir(), 'dsh-standalone-project-'))
/** 只删自己造的记录 —— 出错/中断时也要走这条路。 */
const created = []

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [ENTRY, '--store-dir', REAL_STORE, '--project', project],
  env: {
    ...process.env,
    // 没配后端就让向量通道整体关掉：宁可显式跳过，也不拿 vector.js 里的
    // 默认 exe/model（作者本机路径）在本机硬试，那只会得到一段看不懂的失败日志。
    ...(EMBED_CONFIGURED ? {} : { DSH_MEMORY_VECTOR: 'off' }),
    ...(EMBED_EXE !== '' ? { DSH_MEMORY_EMBED_EXE: EMBED_EXE } : {}),
    ...(EMBED_MODEL !== '' ? { DSH_MEMORY_EMBED_MODEL: EMBED_MODEL } : {}),
    ...(EMBED_ENDPOINT !== '' ? { DSH_MEMORY_EMBED_ENDPOINT: EMBED_ENDPOINT } : {}),
    DSH_MEMORY_EMBED_POOLING: process.env.DSH_MEMORY_EMBED_POOLING ?? 'last',
  },
  stderr: 'pipe',
})
let serverLog = ''
transport.stderr?.on('data', (d) => {
  serverLog += d.toString()
})

const client = new Client({ name: 'standalone-check', version: '1.0.0' })

try {
  await client.connect(transport)
  check(true, 'MCP 服务在无 DSH 情况下冷启动成功')

  console.log('\n1. 向量后端生命周期')
  let backendReady = false
  if (!EMBED_CONFIGURED) {
    skip('自拉起 llama-server', '本机未配置 DSH_MEMORY_EMBED_EXE / DSH_MEMORY_EMBED_MODEL')
    skip('后端 /health 可访问', '同上')
  } else if (EXTERNAL) {
    // 外部端点模式:不 spawn，只确认连得上。
    for (let i = 0; i < 15 && !backendReady; i++) {
      backendReady = await embedHealth(BASE_URL)
      if (!backendReady) await sleep(1000)
    }
    check(backendReady, '配置的外部端点 /health 可访问', BASE_URL)
    skip('自拉起 llama-server', 'DSH_MEMORY_EMBED_ENDPOINT 模式下永不 spawn（设计如此）')
  } else if (ownBusyBefore) {
    // 端口已被占用 ⇒ MCP 只会复用，验证不到"自拉起"。
    for (let i = 0; i < 15 && !backendReady; i++) {
      backendReady = await embedHealth(BASE_URL)
      if (!backendReady) await sleep(1000)
    }
    check(backendReady, '复用了 8199 上已有的向量服务', BASE_URL)
    skip('自拉起 llama-server', '端口起测前已被占用')
  } else {
    // index.js 的 ensureReady 是异步的，给模型加载留时间。
    for (let i = 0; i < 60; i++) {
      await sleep(2000)
      if (await embedHealth(BASE_URL)) {
        backendReady = true
        break
      }
    }
    check(backendReady, 'MCP 自己拉起了 llama-server', backendReady ? '' : `日志：${serverLog.split('\n').slice(-4).join(' / ')}`)
    check(await listeningOn(EMBED_PORT), `${EMBED_PORT} 端口在监听`)
  }
  // 无论复用还是自拉起，都不能去碰 DSH 的端口。
  check((await listeningOn(DSH_PORT)) === dshBusyBefore, `DSH 的 ${DSH_PORT} 状态未被本服务改变（两者互不干扰）`,
    `${dshBusyBefore ? '占用' : '空闲'} → ${(await listeningOn(DSH_PORT)) ? '占用' : '空闲'}`)

  console.log('\n2. 工具可用')
  const { tools } = await client.listTools()
  check(tools.length === 5, 'tools/list 返回 5 个工具', tools.map((t) => t.name).join(','))

  console.log('\n3. 无 DSH 时读取既有记忆')
  const r = await client.callTool({
    name: 'memory_search',
    arguments: { query: 'dsh-memory 记忆插件 存储 JSONL 跨 agent', scope: 'all', topK: 5 },
  })
  const recs = r.structuredContent?.records ?? []
  if (recs.length > 0) {
    check(true, '读到了库里早先写入的记忆', `命中 ${recs.length} 条`)
    console.log(`     首条 score=${recs[0].score} scope=${recs[0].scope}`)
  } else {
    // 空库 / 临时库里本来就没有历史记录，这不是失败。
    skip('读到库里早先写入的记忆', '这份库里没有匹配该查询的记录 —— 新库 / 临时库属正常')
  }

  console.log('\n4. 无 DSH 时的写入能力')
  const marker = `standalone-${Date.now()}`
  const saved = await client.callTool({
    name: 'memory_save',
    arguments: { content: `${marker} 未开 DSH 时由 MCP 独立写入的验收记录`, kind: 'note', importance: 0.5 },
  })
  const newId = saved.structuredContent?.id
  if (newId) created.push(newId)
  check(!!newId, 'memory_save 在无 DSH 时成功', `id=${newId?.slice(0, 8)} scope=${saved.structuredContent?.scope}`)

  console.log('\n5. 语义召回（走向量后端，不是词法）')
  // 措辞与原文完全不同、词法几乎无重叠，只有向量能召回。
  if (!backendReady) {
    skip('语义相近但措辞不同也能召回', '没有可用的向量后端')
  } else {
    const sem = await client.callTool({
      name: 'memory_search',
      arguments: { query: '不用打开主程序也能记录和检索', scope: 'all', topK: 10 },
    })
    const semRecs = sem.structuredContent?.records ?? []
    const hit = semRecs.find((x) => x.content?.includes(marker))
    check(!!hit, '语义相近但措辞不同也能召回', hit ? `score=${hit.score}` : `命中 ${semRecs.length} 条但不含目标`)
  }

  console.log('\n6. 清理（只删本次造的记录）')
  if (newId) {
    const del = await client.callTool({ name: 'memory_forget', arguments: { id: newId } })
    const gone = del.structuredContent?.deleted ?? del.structuredContent?.removed ?? 0
    check(gone >= 1, '清理掉验收记录', `deleted=${gone}`)
  }

  await client.close()
  await sleep(3000)

  console.log('\n7. 退出后不残留孤儿进程')
  // MCP 退出时应连带关掉自己拉起的 llama-server（DSH 不在场，无人接管）。
  if (spawning) {
    check(!(await embedHealth(BASE_URL)), 'MCP 退出后向量后端随之关闭（无孤儿进程）')
    check(!(await listeningOn(EMBED_PORT)), `${EMBED_PORT} 已释放`)
  } else if (EXTERNAL) {
    skip('退出后向量后端随之关闭', '外部端点不归本服务管理（只连不启，也不该被杀）')
    check(await embedHealth(BASE_URL), '外部端点在本服务退出后仍可用（没被误杀）', BASE_URL)
  } else if (!EMBED_CONFIGURED) {
    skip('退出后向量后端随之关闭', '本脚本未启用向量后端')
    skip(`${EMBED_PORT} 已释放`, '同上')
  } else {
    // 复用了别人的服务：它必须还活着。
    check(await embedHealth(BASE_URL), '被复用的向量服务在本服务退出后仍可用（没被误杀）', BASE_URL)
  }
} catch (error) {
  fail++
  console.log(`  ✗ 异常: ${error?.stack ?? error}`)
} finally {
  // 兜底：确保本次造的记录一定被清掉（半路 Ctrl-C 之外的所有路径都会走到这里）。
  try {
    const c2 = new Client({ name: 'standalone-cleanup', version: '1.0.0' })
    const t2 = new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY, '--store-dir', REAL_STORE, '--project', project],
      env: { ...process.env, DSH_MEMORY_VECTOR: 'off' },
      stderr: 'pipe',
    })
    await c2.connect(t2)
    for (const rid of created) {
      try {
        await c2.callTool({ name: 'memory_forget', arguments: { id: rid } })
      } catch {
        /* ignore */
      }
    }
    await c2.close()
  } catch {
    /* ignore */
  }
  try {
    await client.close()
  } catch {
    /* ignore */
  }
  if (!KEEP) {
    try {
      rmSync(project, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  } else {
    console.log(`\n--keep：已保留测试项目目录 ${project}`)
  }
}

console.log(`\n=== 汇总：通过 ${pass}，失败 ${fail}，跳过 ${skipped} ===`)
if (skipped > 0) {
  console.log(`（跳过 ${skipped} 项：退出码 0 只代表「没测出问题」，被跳过的那几项确实没有被验证。）`)
}
console.log(`\n服务端日志（供参考）：\n${serverLog.split('\n').slice(0, 12).join('\n')}`)
process.exit(fail === 0 ? 0 : 1)
