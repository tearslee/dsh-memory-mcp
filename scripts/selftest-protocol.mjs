/**
 * MCP 协议层自测 —— 用**内存版假 store**(不依赖 src/store.js),
 * 验证 stdio 传输、握手、tools/list、tools/call、错误处理是否真的通。
 *
 * 这个脚本**不需要** SharedStore,所以能在 store.js 落地之前就把协议层验完。
 * 它起的是**真的** src/server.js(通过一个临时入口把假 store 注进去)。
 *
 * 用法:node scripts/selftest-protocol.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

let failures = 0
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failures++
  console.log(`${ok ? '  ✅ PASS' : '  ❌ FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`)
}

console.log('═'.repeat(70))
console.log('  MCP 协议层自测(内存版假 store,不依赖 src/store.js)')
console.log('═'.repeat(70))

// ── 造一个临时入口:注入假 store,然后调用真的 src/server.js ──
const tmp = mkdtempSync(join(tmpdir(), 'dsh-mcp-proto-'))
const entry = join(tmp, 'entry.mjs')

writeFileSync(entry, `
import { pathToFileURL } from 'node:url'
const toolsUrl = pathToFileURL(${JSON.stringify(join(ROOT, 'src', 'tools.js'))}).href
const serverUrl = pathToFileURL(${JSON.stringify(join(ROOT, 'src', 'server.js'))}).href
const { createTools } = await import(toolsUrl)
const { startServer } = await import(serverUrl)

class MemStore {
  constructor() { this.records = new Map(); this.n = 0; this.sidecars = new Map() }
  save(input) {
    for (const rec of this.records.values()) {
      if (rec.scope === input.scope && rec.content === input.content) {
        rec.updatedAt = Date.now(); rec.accessCount += 1
        return { deduped: true, record: rec }
      }
    }
    const now = Date.now()
    const rec = {
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-' + String(++this.n).padStart(12, '0'),
      scope: input.scope, kind: input.kind ?? 'note', content: input.content,
      tags: input.tags ?? [], source: { origin: 'explicit' },
      createdAt: now, updatedAt: now, lastAccessedAt: now, accessCount: 0,
      importance: input.importance ?? 0.5,
    }
    this.records.set(rec.id, rec)
    return { deduped: false, record: rec }
  }
  deleteById(id) { const r = this.records.get(id); if (!r) return { deleted: false }; this.records.delete(id); return { deleted: true, record: r } }
  deleteByQuery(scope, q) {
    const ids = [...this.records.values()].filter(r => r.scope === scope && r.content.includes(q)).map(r => r.id)
    for (const id of ids) this.records.delete(id)
    return { deleted: ids.length, ids }
  }
  listRecords({ scopeKeys, kind, limit } = {}) {
    let l = [...this.records.values()]
    if (scopeKeys && scopeKeys.length) l = l.filter(r => scopeKeys.includes(r.scope))
    if (kind) l = l.filter(r => r.kind === kind)
    l.sort((a, b) => b.updatedAt - a.updatedAt)
    if (limit) l = l.slice(0, limit)
    return l
  }
  allScopeKeys() { return [...new Set([...this.records.values()].map(r => r.scope))] }
  readSidecar(k) { return this.sidecars.get(k) ?? { identity: '', model: '', dims: 0, vectors: new Map() } }
  appendSidecar(k, id, v) { const s = this.sidecars.get(k) ?? { identity: '', model: '', dims: 0, vectors: new Map() }; s.vectors.set(id, v); this.sidecars.set(k, s) }
  touchMany(ids) { for (const id of ids) { const r = this.records.get(id); if (r) r.accessCount += 1 } }
}

const handlers = createTools({
  store: new MemStore(),
  config: { projectBasePath: 'D:\\\\dev\\\\proj', defaultSaveScope: 'global' },
})
await startServer(handlers)
`, 'utf8')

// ── 起客户端 ──
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  stderr: 'pipe',
})
const stderrChunks = []
transport.stderr?.on('data', (c) => stderrChunks.push(c.toString()))
const client = new Client({ name: 'proto-selftest', version: '1.0.0' }, { capabilities: {} })

console.log('\n[1] initialize 握手')
await client.connect(transport)
const info = client.getServerVersion()
check('握手成功', Boolean(info?.name), `serverInfo=${JSON.stringify(info)}`)
check('server 声明 tools 能力', Boolean(client.getServerCapabilities()?.tools),
  JSON.stringify(client.getServerCapabilities()))

console.log('\n[2] tools/list')
const list = await client.listTools()
check('5 个工具', list.tools.length === 5, `${list.tools.length} 个`)
check('名字正确', JSON.stringify(list.tools.map(t => t.name).sort())
  === JSON.stringify(['memory_forget', 'memory_get', 'memory_list', 'memory_save', 'memory_search']),
  list.tools.map(t => t.name).join(','))
check('每个工具都有 inputSchema', list.tools.every(t => t.inputSchema?.type === 'object'))
check('每个工具都有 outputSchema', list.tools.every(t => t.outputSchema !== undefined))
check('description 非空', list.tools.every(t => typeof t.description === 'string' && t.description.length > 10),
  `最短 ${Math.min(...list.tools.map(t => t.description.length))} 字符`)

console.log('\n[3] tools/call —— 正常路径')
async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args })
  return {
    text: (res.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n'),
    structured: res.structuredContent,
    isError: res.isError === true,
  }
}
let r = await call('memory_save', { content: '协议层自测:Trae 与 WorkBuddy 共享记忆', scope: 'project', kind: 'procedure', importance: 0.7 })
const id = r.structured?.id
check('memory_save 成功', r.structured?.ok === true && Boolean(id), `id=${id}`)
check('返回 structuredContent', r.structured !== undefined)
check('返回 content 文本', r.text.length > 0, r.text.split('\n')[0])

r = await call('memory_search', { query: 'Trae WorkBuddy 共享记忆', scope: 'project' })
check('memory_search 命中', (r.structured?.records ?? []).some(x => x.id === id),
  `count=${r.structured?.count}`)

r = await call('memory_list', { scope: 'project' })
check('memory_list 列出', r.structured?.count === 1, `count=${r.structured?.count}`)

r = await call('memory_get', { ids: [id.slice(0, 8)] })
check('memory_get 用前缀取回', r.structured?.records?.[0]?.id === id, '')

r = await call('memory_forget', { id })
check('memory_forget 删掉', r.structured?.deleted === 1, r.text.split('\n')[0])

console.log('\n[4] tools/call —— 错误路径(isError,不是协议错误)')
r = await call('memory_forget', {})
check('TARGET_REQUIRED 以 isError 返回', r.isError === true && r.structured?.code === 'TARGET_REQUIRED',
  r.text)
r = await call('memory_save', { content: 'x', importance: 9 })
check('IMPORTANCE_RANGE 以 isError 返回', r.isError === true && r.structured?.code === 'IMPORTANCE_RANGE',
  r.text)
r = await call('memory_search', { query: 'x', scope: 'bad:name' })
check('SCOPE_INVALID 以 isError 返回', r.isError === true && r.structured?.code === 'SCOPE_INVALID',
  r.text)

console.log('\n[5] stdout 纯净性')
const stderrText = stderrChunks.join('')
check('server 日志走 stderr', stderrText.includes('[dsh-memory-mcp]'),
  stderrText.trim().split('\n')[0] ?? '(空)')

await client.close()
rmSync(tmp, { recursive: true, force: true })

console.log(`\n共 ${results.length} 项检查,通过 ${results.length - failures} 项,失败 ${failures} 项。`)
if (failures > 0) {
  console.log('\n失败项:')
  for (const x of results.filter(y => !y.ok)) console.log(`  - ${x.name}\n      ${x.detail}`)
}
process.exit(failures > 0 ? 1 : 0)
