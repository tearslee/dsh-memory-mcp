/**
 * 端到端验收：对**真实** storeDir 跑一遍 MCP 协议，然后复原。
 *
 * 与 selftest.mjs 的区别：自测跑在临时目录，本脚本刻意打到 D:/dev/.dsh-memory-store，
 * 因为「能不能与 DSH 插件共用同一份数据」正是本次要证明的事。
 * 写入的记录会在结束时按 id 精确删除（只删自己造的），并保留基线快照供比对。
 *
 * 用法：node scripts/acceptance-real.mjs [--keep]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = resolve(HERE, '..', 'src', 'index.js')
const REAL_STORE = 'D:/dev/.dsh-memory-store'
const KEEP = process.argv.includes('--keep')

let pass = 0
let fail = 0
function check(ok, label, extra = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${label}${extra ? `  ${extra}` : ''}`)
  } else {
    fail++
    console.log(`  ✗ FAIL  ${label}${extra ? `  ${extra}` : ''}`)
  }
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

const marker = `acceptance-${Date.now()}`
const project = join(tmpdir(), `dsh-acc-project-${Date.now()}`)
const before = snapshot(REAL_STORE)

console.log(`\n=== 端到端验收：对真实 storeDir ${REAL_STORE} ===`)
console.log(`测试项目: ${project}`)
console.log(`标记: ${marker}\n`)

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

  console.log('\n2. 写入真实 store（memory_save）')
  const content = `${marker} 端到端验收记忆：Trae 与 WorkBuddy 通过 MCP 写入真实 storeDir，验证与 DSH 插件共用同一份数据。`
  const saved = await client.callTool({
    name: 'memory_save',
    arguments: { content, kind: 'note', tags: ['acceptance'], importance: 0.5, project },
  })
  const sc = saved.structuredContent ?? {}
  const id = sc.id ?? sc.record?.id
  check(!!id, 'memory_save 返回 id', `id=${id?.slice(0, 8)} scope=${sc.scope ?? sc.record?.scope}`)
  if (id) created.push(id)

  console.log('\n3. 落盘可见（磁盘上真的多了一条）')
  const after = snapshot(REAL_STORE)
  const grew = [...after.entries()].filter(([k, v]) => !before.has(k) || before.get(k) !== v)
  check(grew.length > 0, '真实 store 目录文件发生变化', grew.map(([k]) => k).join(', '))

  console.log('\n4. 跨进程读回（memory_search，scope=all）')
  const found = await client.callTool({
    name: 'memory_search',
    arguments: { query: marker, scope: 'all', topK: 5 },
  })
  const recs = found.structuredContent?.records ?? []
  check(recs.length > 0, 'memory_search 返回了记录', `命中 ${recs.length} 条`)
  check(recs.some((r) => r.id === id), '刚写入的记忆能被检索回来')
  const sc0 = recs.find((r) => r.id === id)?.score
  check(typeof sc0 === 'number', '检索结果带 score', `score=${sc0}`)

  console.log('\n5. 能读到 DSH 插件早已写入的记忆（互通证明）')
  const legacy = await client.callTool({
    name: 'memory_search',
    arguments: { query: 'dsh-memory 记忆插件 存储 JSONL', scope: 'all', topK: 10 },
  })
  const legacyRecs = legacy.structuredContent?.records ?? []
  check(legacyRecs.length > 0, '检索到 DSH 既有记忆', `命中 ${legacyRecs.length} 条`)
  const scopesSeen = [...new Set(legacyRecs.map((r) => r.scope))]
  console.log(`     作用域分布: ${scopesSeen.join(' | ')}`)

  console.log('\n6. 幂等（相同内容再存一次）')
  const again = await client.callTool({
    name: 'memory_save',
    arguments: { content, project },
  })
  check(again.structuredContent?.deduped === true, '重复保存返回 deduped=true')

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
  check(!(gone.structuredContent?.records ?? []).some((r) => r.id === id), '删除后检索不到')

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
  try {
    rmSync(project, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

const finalSnap = snapshot(REAL_STORE)
const newFiles = [...finalSnap.keys()].filter((k) => !before.has(k))
if (!KEEP && newFiles.length > 0) {
  console.log(`\n注意：真实 store 出现了 ${newFiles.length} 个新文件（多半是本测试项目的 scope 文件，属正常）:`)
  for (const f of newFiles) console.log(`  - ${f}`)
}

console.log(`\n=== 汇总：通过 ${pass}，失败 ${fail} ===`)
process.exit(fail === 0 ? 0 : 1)