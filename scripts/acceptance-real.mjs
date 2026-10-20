/**
 * 端到端验收：对**真实** storeDir 跑一遍 MCP 协议，然后复原。
 *
 * 与 selftest.mjs 的区别：自测跑在临时目录，本脚本刻意打到**你自己的** DSH 记忆库，
 * 因为「能不能与 DSH 插件共用同一份数据」正是本次要证明的事。
 * 写入的记录会在结束时按 id 精确删除（只删自己造的），并保留基线快照供比对。
 *
 * ⚠️ 真实库路径**必须由调用方显式给出** —— 脚本绝不猜、也绝不回退到某个写死的机器路径：
 *      DSH_MEMORY_REAL_STORE=<你 DSH 插件在用的 storeDir>
 *    没设就打印提示并 exit 0 跳过（这是可选验收，"没配"不该算失败）。
 *    想先验证脚本自身逻辑是否通，把它指向一个临时目录即可（不会碰真实库）。
 *
 * ⚠️ 写入用的是 `memory_save` 的 **path** 参数（不是 `project`）：
 *    schema 里只有 `path` 能把记录落到 `project:<绝对路径>`，传 `project` 会被静默忽略、
 *    实际写进 `global`。第 2 节因此**显式断言** scope 等于 `project:<测试目录>`，
 *    否则参数名写错时会得到一份"全绿但什么都没测到"的报告。
 *
 * 用法：DSH_MEMORY_REAL_STORE=<dir> node scripts/acceptance-real.mjs [--keep]
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
// 期望值用**被测实现自己的**归一化口径算出来 —— 在脚本里另写一份等于自己跟自己对答案。
import { normalizeProjectPath, projectScopeKey } from '../src/tools.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = resolve(HERE, '..', 'src', 'index.js')
const REAL_STORE = resolveRealStore()
const KEEP = process.argv.includes('--keep')
const MARKER_PREFIX = 'acceptance'

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
/** 跳过不计入失败:这些检查依赖"环境恰好具备某条件",不具备就不该判红。 */
function skip(label, reason = '') {
  skipped++
  console.log(`  ─ 跳过  ${label}${reason ? `  (${reason})` : ''}`)
}

/** 真实库路径 —— 只认环境变量,未配置返回 null（绝不回退到任何写死路径）。 */
function resolveRealStore() {
  const raw = typeof process.env.DSH_MEMORY_REAL_STORE === 'string' ? process.env.DSH_MEMORY_REAL_STORE.trim() : ''
  return raw === '' ? null : resolve(raw)
}

function snapshot(root) {
  const out = new Map()
  const walk = (dir, prefix = '') => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === '.locks') continue
      const full = join(dir, e.name)
      const key = `${prefix}${e.name}`
      if (e.isDirectory()) walk(full, `${key}/`)
      else out.set(key, statSync(full).size)
    }
  }
  walk(root)
  return out
}

async function connect(project) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY, '--store-dir', REAL_STORE, '--project', project],
    env: { ...process.env, DSH_MEMORY_VECTOR: process.env.DSH_MEMORY_VECTOR ?? 'on' },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'acceptance-real', version: '0.1.0' })
  await client.connect(transport)
  return { client, transport }
}

// ── 前置:没配真实库就跳过(exit 0),并说清为什么要由你来配 ──────────
if (REAL_STORE === null) {
  console.log('\n=== 端到端验收：与真实 storeDir 共存 ===')
  console.log('')
  console.log('⚠️  未配置 DSH_MEMORY_REAL_STORE，本脚本跳过（退出码 0）。')
  console.log('    这是**可选**验收：它证明的是「与 DSH 插件共用同一份记忆库」，')
  console.log('    所以目标库必须由你显式指定 —— 脚本不会猜路径，也不会自己挑一个目录当"真实库"。')
  console.log('')
  console.log('    PowerShell:  $env:DSH_MEMORY_REAL_STORE = "D:\\dev\\.dsh-memory-store"; node scripts/acceptance-real.mjs')
  console.log('    bash / zsh :  DSH_MEMORY_REAL_STORE=~/.dsh-memory-store node scripts/acceptance-real.mjs')
  console.log('')
  console.log('    ⇒ 只想先确认脚本自身跑得通？指向一个临时目录即可（不会碰你的真实库）：')
  console.log('      PowerShell:  $env:DSH_MEMORY_REAL_STORE = Join-Path $env:TEMP "dsh-store-dryrun"')
  console.log('')
  process.exit(0)
}

const marker = `${MARKER_PREFIX}-${Date.now()}`
const project = join(tmpdir(), `dsh-acc-project-${Date.now()}`)
const expectedScope = projectScopeKey(normalizeProjectPath(project))
const before = snapshot(REAL_STORE)

console.log('\n=== 端到端验收：与真实 storeDir 共存 ===')
console.log(`真实 store : ${REAL_STORE}`)
console.log(`测试项目   : ${project}`)
console.log(`期望作用域 : ${expectedScope}`)
console.log(`标记       : ${marker}`)
if (!existsSync(REAL_STORE)) {
  console.log('⚠️  该目录当前不存在，服务会自动创建；若这不是你要验的那份库，请改 DSH_MEMORY_REAL_STORE。')
}
console.log('')

const created = []
let client
let transport
try {
  ;({ client, transport } = await connect(project))

  console.log('1. 握手与工具清单')
  const v = client.getServerVersion()
  check(!!v?.name, 'server 版本可见', `name=${v?.name} version=${v?.version}`)
  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name).sort()
  check(names.length === 5, 'tools/list 返回 5 个工具', names.join(','))

  console.log('\n2. 写入真实 store（memory_save + path ⇒ project 作用域）')
  const content = `${marker} 端到端验收记忆：Trae 与 WorkBuddy 通过 MCP 写入真实 storeDir，验证与 DSH 插件共用同一份数据。`
  const saved = await client.callTool({
    name: 'memory_save',
    arguments: { content, kind: 'note', tags: ['acceptance'], importance: 0.5, path: project },
  })
  const sc = saved.structuredContent ?? {}
  const id = sc.id ?? sc.record?.id
  check(!!id, 'memory_save 返回 id', `id=${id?.slice(0, 8)}`)
  if (id) created.push(id)
  // ★ 本次最重要的一条：证明记录真的落在 project:<该目录>，而不是静默回退到 global。
  //   旧版脚本传的是 schema 里不存在的 `project` 参数，被静默忽略，于是整节一直在 global 桶里转。
  check(sc.scope === expectedScope, '写入落在 project 作用域（不是 global）',
    `scope=${sc.scope ?? '(空)'} 期望=${expectedScope}`)

  console.log('\n3. 落盘可见（磁盘上真的多了一条）')
  const after = snapshot(REAL_STORE)
  const grew = [...after.entries()].filter(([k, v]) => !before.has(k) || before.get(k) !== v)
  check(grew.length > 0, '真实 store 目录文件发生变化', grew.map(([k]) => k).join(', '))
  // 项目作用域落在 projects/<sha1>.jsonl；global 则是 global.jsonl。
  // 这一条从**文件名**侧再确认一次作用域，不只信工具返回值。
  check(grew.some(([k]) => k.startsWith('projects/')), '新增的是 projects/ 下的项目作用域文件',
    grew.length > 0 ? grew.map(([k]) => k).join(', ') : '(无变化)')

  console.log('\n4. 跨作用域读回（memory_search，scope=all）')
  const found = await client.callTool({
    name: 'memory_search',
    arguments: { query: marker, scope: 'all', topK: 5 },
  })
  const recs = found.structuredContent?.records ?? []
  check(recs.length > 0, 'memory_search 返回了记录', `命中 ${recs.length} 条`)
  const back = recs.find((r) => r.id === id)
  check(!!back, '刚写入的记忆能被检索回来')
  // scope=all 必须把作用域**带出来**，否则"跨作用域"这三个字无从验证。
  check(back?.scope === expectedScope, '检索结果带出 project 作用域', `scope=${back?.scope ?? '(空)'}`)
  check(typeof back?.score === 'number', '检索结果带 score', `score=${back?.score}`)

  console.log('\n5. 能读到 DSH 插件早已写入的记忆（互通证明）')
  const legacy = await client.callTool({
    name: 'memory_search',
    arguments: { query: 'dsh-memory 记忆插件 存储 JSONL', scope: 'all', topK: 10 },
  })
  // 必须排除**本次自己刚写的**那条：它同样含 "dsh-memory / 记忆 / JSONL" 等词，
  // 不排除的话这一节会拿自己的记录冒充"DSH 既有记忆"，白白绿一次。
  const legacyRecs = (legacy.structuredContent?.records ?? [])
    .filter((r) => r.id !== id && !String(r.content ?? '').includes(marker))
  if (legacyRecs.length > 0) {
    check(true, '检索到 DSH 既有记忆（已排除本次自造的记录）', `命中 ${legacyRecs.length} 条`)
    const scopesSeen = [...new Set(legacyRecs.map((r) => r.scope))]
    console.log(`     作用域分布: ${scopesSeen.join(' | ')}`)
  } else {
    // 这一节依赖"库里恰好有能命中的既有记录"。空库 / 临时库里没有是正常的，
    // 报 FAIL 只会误导人（旧版就是这样把环境问题算成代码回归）。
    skip('检索到 DSH 既有记忆', '这份库里没有匹配该查询的记录 —— 新库 / 临时库属正常')
  }

  console.log('\n6. 幂等（相同内容再存一次）')
  const again = await client.callTool({
    name: 'memory_save',
    arguments: { content, path: project },
  })
  check(again.structuredContent?.deduped === true, '重复保存返回 deduped=true')
  const againId = again.structuredContent?.id
  check(againId === id, '去重命中同一条记录（没有新增第二条）', `id=${againId?.slice(0, 8)}`)

  console.log('\n7. memory_list / memory_get')
  const listed = await client.callTool({ name: 'memory_list', arguments: { limit: 5 } })
  check(Array.isArray(listed.structuredContent?.records), 'memory_list 返回记录数组')
  const got = await client.callTool({ name: 'memory_get', arguments: { ids: [id.slice(0, 8)] } })
  const gr = got.structuredContent?.records ?? []
  check(gr.some((r) => r.id === id), 'memory_get 用 8 位前缀取回', `missing=${(got.structuredContent?.missing ?? []).length}`)

  console.log('\n8. 清理（只删本次造的记录）')
  const del = await client.callTool({ name: 'memory_forget', arguments: { id } })
  const deleted = del.structuredContent?.deleted ?? del.structuredContent?.removed ?? 0
  check(deleted >= 1, 'memory_forget 删掉了自己那条', `deleted=${deleted}`)
  const gone = await client.callTool({ name: 'memory_search', arguments: { query: marker, scope: 'all', topK: 5 } })
  const left = gone.structuredContent?.records ?? []
  check(!left.some((r) => r.id === id), '删除后检索不到')
  // 旧版假测试的问题正是"全在 global 里转"：这条专盯它，删完 global 必须干净。
  check(!left.some((r) => r.scope === 'global'), 'global 作用域没有留下本次的痕迹',
    left.length > 0 ? left.map((r) => r.scope).join(', ') : '')

  await client.close()
} catch (error) {
  fail++
  console.log(`  ✗ 异常: ${error?.stack ?? error}`)
  try {
    await client?.close()
  } catch {
    /* ignore */
  }
} finally {
  // 兜底：确保本次造的记录一定被清掉
  try {
    const c2 = new Client({ name: 'cleanup', version: '0.1.0' })
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
  if (!KEEP) {
    try {
      rmSync(project, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

const finalSnap = snapshot(REAL_STORE)
const newFiles = [...finalSnap.keys()].filter((k) => !before.has(k))

// 清理本次**新建**的 scope 文件(空壳)。
//
// ⚠️ 为什么要脚本自己删:`SharedStore.persist()` 对非 global 作用域在记录清空时
// 只写空文件、**不删文件**(这是与上游兼容的刻意行为,`global` 更是永不删)。
// 所以「按 id 删掉记录」之后,`projects/<sha1>.jsonl` 会以 0 字节常驻 ——
// 在真实库上反复跑几次就会攒一堆空壳。这里只删**本次新出现且确实为空**的文件,
// 绝不动任何先前就存在的文件(那是别人的记忆)。
const removedShells = []
for (const f of newFiles) {
  const full = join(REAL_STORE, f)
  try {
    if (f.endsWith('.jsonl')) {
      if (readFileSync(full, 'utf8').trim() === '') {
        rmSync(full, { force: true })
        removedShells.push(f)
      }
      continue
    }
    if (f.endsWith('.vec')) {
      // 向量边车「没有数据行」= 只剩 `#model\tdims` 头(或干脆空),没有任何向量。
      // 记录已按 id 删光时 removeVectors() 会留下这种只有头的文件;
      // 它承载着「本 scope 用过哪个模型」这一个事实,但对已空的 scope 没有意义,
      // 在这个 scope 的 .jsonl 也被本次删掉的前提下,一并删掉是安全的。
      const lines = readFileSync(full, 'utf8').split('\n').filter((l) => l.trim() !== '')
      const onlyHeader = lines.every((l) => l.startsWith('#'))
      if (onlyHeader) {
        rmSync(full, { force: true })
        removedShells.push(f)
      }
    }
  } catch {
    /* 删不掉就留着,不影响结论 */
  }
}

if (newFiles.length > 0) {
  const leftover = newFiles.filter((f) => !removedShells.includes(f))
  console.log(`\n清理：本次新出现 ${newFiles.length} 个文件`)
  if (removedShells.length > 0) {
    console.log(`  已删除 ${removedShells.length} 个空壳（记录按 id 删光后留下的 0 字节 scope 文件）:`)
    for (const f of removedShells) console.log(`    - ${f}`)
  }
  if (leftover.length > 0) {
    console.log(`  ⚠️ 保留 ${leftover.length} 个（非空或删不掉，请人工确认，不要直接 rm）:`)
    for (const f of leftover) console.log(`    - ${f}`)
  }
  console.log('  说明：project 作用域的空壳文件不影响 DSH 读取；此处清理只为保持真实库整洁。')
}

console.log(`\n=== 汇总：通过 ${pass}，失败 ${fail}，跳过 ${skipped} ===`)
process.exit(fail === 0 ? 0 : 1)
