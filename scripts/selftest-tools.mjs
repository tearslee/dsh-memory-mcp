/**
 * 工具层单元自测 —— 不依赖 MCP SDK,也不依赖存储层。
 * 用一个**内存版**的假 store 验证参数校验、scope 决策与渲染。
 *
 * 用法:node scripts/selftest-tools.mjs
 */
import { normalizeProjectPath, projectScopeKey, createTools, runTool, TOOL_NAMES, TOOL_SCHEMAS } from '../src/tools.js'

let failures = 0
const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failures++
  console.log(`${ok ? '  ✅ PASS' : '  ❌ FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`)
}

/** 内存版假 store —— 形状与 SharedStore 一致。 */
class FakeStore {
  constructor() {
    this.records = new Map()
    this.sidecars = new Map()
    this.n = 0
  }

  save(input) {
    for (const rec of this.records.values()) {
      if (rec.scope === input.scope && rec.content.toLowerCase().trim() === input.content.toLowerCase().trim()) {
        rec.updatedAt = Date.now()
        rec.accessCount += 1
        return { deduped: true, record: rec }
      }
    }
    const now = Date.now()
    const rec = {
      id: `00000000-0000-4000-8000-${String(++this.n).padStart(12, '0')}`,
      scope: input.scope,
      kind: input.kind ?? 'note',
      content: input.content,
      tags: input.tags ?? [],
      source: { origin: 'explicit' },
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      importance: input.importance ?? 0.5,
      ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    }
    this.records.set(rec.id, rec)
    return { deduped: false, record: rec }
  }

  deleteById(id) {
    const rec = this.records.get(id)
    if (!rec) return { deleted: false }
    this.records.delete(id)
    return { deleted: true, record: rec }
  }

  deleteByQuery(scopeKey, query) {
    const needle = query.toLowerCase().trim()
    const ids = [...this.records.values()].filter((r) => r.scope === scopeKey && r.content.toLowerCase().includes(needle)).map((r) => r.id)
    for (const id of ids) this.records.delete(id)
    return { deleted: ids.length, ids }
  }

  listRecords({ scopeKeys, kind, limit } = {}) {
    let list = [...this.records.values()]
    if (scopeKeys && scopeKeys.length > 0) list = list.filter((r) => scopeKeys.includes(r.scope))
    if (kind) list = list.filter((r) => r.kind === kind)
    list = list.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
    if (limit) list = list.slice(0, limit)
    return list
  }

  allScopeKeys() {
    return [...new Set([...this.records.values()].map((r) => r.scope))]
  }

  readSidecar(scopeKey) {
    return this.sidecars.get(scopeKey) ?? { identity: '', model: '', dims: 0, vectors: new Map() }
  }

  appendSidecar(scopeKey, id, vec) {
    const sc = this.sidecars.get(scopeKey) ?? { identity: '', model: '', dims: 0, vectors: new Map() }
    sc.vectors.set(id, vec)
    this.sidecars.set(scopeKey, sc)
  }
}

console.log('═'.repeat(70))
console.log('  工具层单元自测(不依赖 MCP SDK / 存储层)')
console.log('═'.repeat(70))

// ── 路径归一化 ──────────────────────────────────────────────────
console.log('\n[1] 路径归一化')
check('绝对路径去掉末尾分隔符', normalizeProjectPath('D:\\dev\\app\\', 'C:\\x') === 'D:\\dev\\app', normalizeProjectPath('D:\\dev\\app\\', 'C:\\x'))
check('盘符统一大写', normalizeProjectPath('c:\\dev\\app', 'C:\\x') === 'C:\\dev\\app', normalizeProjectPath('c:\\dev\\app', 'C:\\x'))
check('折叠 . 与 ..', normalizeProjectPath('D:\\dev\\app\\..\\app', 'C:\\x') === 'D:\\dev\\app', normalizeProjectPath('D:\\dev\\app\\..\\app', 'C:\\x'))
check('相对路径按 base 解析', normalizeProjectPath('sub', 'D:\\dev\\app') === 'D:\\dev\\app\\sub', normalizeProjectPath('sub', 'D:\\dev\\app'))
check('相对路径按 base 解析(带 ..)', normalizeProjectPath('..\\other', 'D:\\dev\\app') === 'D:\\dev\\other', normalizeProjectPath('..\\other', 'D:\\dev\\app'))
check('projectScopeKey 形状', projectScopeKey('D:\\dev\\app') === 'project:D:\\dev\\app', projectScopeKey('D:\\dev\\app'))

// ── scope 决策 ──────────────────────────────────────────────────
console.log('\n[2] scope 决策')
const PROJECT = 'D:\\dev\\proj'
const handlers = createTools({
  store: new FakeStore(),
  config: { projectBasePath: PROJECT, defaultSaveScope: 'global' },
})
const projectKey = `project:${PROJECT}`

// memory_save 省略 scope → global
let r = await runTool(handlers, 'memory_save', { content: '默认作用域测试' })
check('memory_save 省略 scope → global', r.structuredContent.scope === 'global', `scope=${r.structuredContent.scope}`)
check('memory_save 省略 kind → note', r.structuredContent.kind === 'note', `kind=${r.structuredContent.kind}`)
check('memory_save 渲染文本', r.content[0].text.startsWith('已保存记忆 '), r.content[0].text)

// memory_save scope=project → project
r = await runTool(handlers, 'memory_save', { content: '项目作用域测试', scope: 'project' })
check('memory_save scope=project → 当前项目', r.structuredContent.scope === projectKey, `scope=${r.structuredContent.scope}`)

// memory_save path= → project:<绝对路径>
r = await runTool(handlers, 'memory_save', { content: 'path 作用域测试', path: 'D:\\dev\\other' })
check('memory_save path= → project:<绝对路径>', r.structuredContent.scope === 'project:D:\\dev\\other', `scope=${r.structuredContent.scope}`)

// path 归一化:同一目录不同写法必须落到同一个 scope
r = await runTool(handlers, 'memory_save', { content: 'path 归一化 A', path: 'D:\\dev\\other\\' })
const scopeA = r.structuredContent.scope
r = await runTool(handlers, 'memory_save', { content: 'path 归一化 B', path: 'd:\\dev\\other' })
check('同一目录的不同写法归一到同一个 scope', scopeA === r.structuredContent.scope, `${scopeA} vs ${r.structuredContent.scope}`)

// path + scope='global' → 冲突
r = await runTool(handlers, 'memory_save', { content: '冲突测试', path: 'D:\\dev\\other', scope: 'global' })
check('path + scope=global → PATH_SCOPE_CONFLICT', r.isError === true && r.structuredContent.code === 'PATH_SCOPE_CONFLICT', r.content[0].text)

// ── 幂等 ────────────────────────────────────────────────────────
console.log('\n[3] 幂等')
const c1 = '幂等测试内容'
r = await runTool(handlers, 'memory_save', { content: c1, scope: 'project' })
const id1 = r.structuredContent.id
r = await runTool(handlers, 'memory_save', { content: c1, scope: 'project' })
check('重复保存 → deduped=true', r.structuredContent.deduped === true, `text=${r.content[0].text}`)
check('重复保存 → id 不变', r.structuredContent.id === id1, `${id1} vs ${r.structuredContent.id}`)

// ── 校验错误 ────────────────────────────────────────────────────
console.log('\n[4] 校验错误')
const cases = [
  ['memory_save', {}, 'CONTENT_EMPTY'],
  ['memory_save', { content: 'x', importance: 1.5 }, 'IMPORTANCE_RANGE'],
  ['memory_save', { content: 'x', importance: -0.1 }, 'IMPORTANCE_RANGE'],
  ['memory_save', { content: 'x', kind: 'bogus' }, 'KIND_INVALID'],
  ['memory_search', {}, 'QUERY_EMPTY'],
  ['memory_search', { query: 'x', topK: 0 }, 'TOPK_RANGE'],
  ['memory_search', { query: 'x', topK: 21 }, 'TOPK_RANGE'],
  ['memory_list', { limit: 0 }, 'LIMIT_RANGE'],
  ['memory_list', { limit: 201 }, 'LIMIT_RANGE'],
  ['memory_list', { kind: 'bogus' }, 'KIND_INVALID'],
  ['memory_get', { ids: [] }, 'IDS_EMPTY'],
  ['memory_forget', {}, 'TARGET_REQUIRED'],
  ['memory_forget', { id: 'a', query: 'b' }, 'TARGET_AMBIGUOUS'],
  ['memory_search', { query: 'x', scope: 'bad:name' }, 'SCOPE_INVALID'],
  ['memory_search', { query: 'x', scope: 'global:name' }, 'SCOPE_INVALID'],
  ['memory_save', { content: 'x', scope: 'all' }, 'SCOPE_NOT_WRITABLE'],
  ['memory_forget', { query: 'x', scope: 'all' }, 'SCOPE_NOT_WRITABLE'],
]
for (const [tool, args, expected] of cases) {
  const res = await runTool(handlers, tool, args)
  check(`${tool}(${JSON.stringify(args)}) → ${expected}`,
    res.isError === true && res.structuredContent?.code === expected,
    `实际 code=${res.structuredContent?.code} text=${res.content[0].text}`)
}

// ── 检索渲染 ────────────────────────────────────────────────────
console.log('\n[5] 检索渲染与排序')
r = await runTool(handlers, 'memory_save', {
  content: '项目里的记忆:前端统一使用 TypeScript 严格模式', scope: 'project', kind: 'decision', importance: 0.9,
})
const searchRes = await runTool(handlers, 'memory_search', { query: 'TypeScript 严格模式', scope: 'project' })
check('检索命中', searchRes.structuredContent.count >= 1, `count=${searchRes.structuredContent.count}`)
check('检索文本格式 [score] (scope/kind) 内容',
  /\[\d\.\d{4}\] \(project:[^)]*\/decision\) /.test(searchRes.content[0].text),
  searchRes.content[0].text.split('\n')[0])
check('检索结果带 8 位 id 前缀', /id=[0-9a-f]{8}/.test(searchRes.content[0].text), '')
check('score 保留 4 位小数', searchRes.structuredContent.records.every((x) => Math.round(x.score * 10000) === x.score * 10000),
  JSON.stringify(searchRes.structuredContent.records.map((x) => x.score)))

// 默认检索范围 = 当前项目 + global
r = await runTool(handlers, 'memory_search', { query: '作用域' })
check('省略 scope 时检索范围 = 当前项目 + global',
  JSON.stringify(r.structuredContent.scopes) === JSON.stringify([projectKey, 'global']),
  JSON.stringify(r.structuredContent.scopes))

// 默认列表范围
r = await runTool(handlers, 'memory_list', {})
check('省略 scope 时列表范围 = 当前项目 + global',
  JSON.stringify(r.structuredContent.scopes) === JSON.stringify([projectKey, 'global']),
  JSON.stringify(r.structuredContent.scopes))

// list 的 kind 过滤
r = await runTool(handlers, 'memory_list', { scope: 'project', kind: 'decision' })
check('list 的 kind 过滤生效', r.structuredContent.records.every((x) => x.kind === 'decision'),
  JSON.stringify(r.structuredContent.records.map((x) => x.kind)))

// ── memory_get ──────────────────────────────────────────────────
console.log('\n[6] memory_get')
const saved = await runTool(handlers, 'memory_save', { content: 'get 测试内容', scope: 'project' })
const fullId = saved.structuredContent.id
const prefix = fullId.slice(0, 8)
r = await runTool(handlers, 'memory_get', { ids: [prefix] })
check('8 位前缀能取回', r.structuredContent.records.length === 1 && r.structuredContent.records[0].id === fullId,
  JSON.stringify(r.structuredContent.records.map((x) => x.id)))
check('missing 为空', r.structuredContent.missing.length === 0, JSON.stringify(r.structuredContent.missing))
r = await runTool(handlers, 'memory_get', { ids: [prefix, prefix, fullId] })
check('自动去重', r.structuredContent.records.length === 1, `count=${r.structuredContent.records.length}`)
r = await runTool(handlers, 'memory_get', { ids: ['ffffffff'] })
check('找不到的 id 进 missing', r.structuredContent.missing.includes('ffffffff'), JSON.stringify(r.structuredContent.missing))

// ── memory_forget ──────────────────────────────────────────────
console.log('\n[7] memory_forget')
r = await runTool(handlers, 'memory_forget', { id: fullId })
check('按 id 删除 → deleted=1', r.structuredContent.deleted === 1, r.content[0].text)
check('删除文本渲染', /已删除 1 条记忆/.test(r.content[0].text), r.content[0].text)
r = await runTool(handlers, 'memory_search', { query: 'get 测试内容', scope: 'project' })
check('删除后搜不到', !r.structuredContent.records.some((x) => x.id === fullId), '')

// query 路径:省略 scope → 只作用当前项目
await runTool(handlers, 'memory_save', { content: '批量删除目标内容 abc', scope: 'project' })
await runTool(handlers, 'memory_save', { content: '批量删除目标内容 abc', scope: 'global' })
r = await runTool(handlers, 'memory_forget', { query: '批量删除目标内容' })
check('query + 省略 scope → 只删当前项目', r.structuredContent.deleted === 1,
  `deleted=${r.structuredContent.deleted} scope=${r.structuredContent.scope}`)
r = await runTool(handlers, 'memory_list', { scope: 'global' })
check('global 里那条还在', r.structuredContent.records.some((x) => x.content.includes('批量删除目标内容')),
  JSON.stringify(r.structuredContent.records.map((x) => x.content)))

// ── 自定义作用域 ────────────────────────────────────────────────
console.log('\n[8] 自定义作用域')
r = await runTool(handlers, 'memory_save', { content: '自定义作用域内容', scope: '项目笔记' })
check('自定义名被规范化(小写)', r.structuredContent.scope === '项目笔记', `scope=${r.structuredContent.scope}`)
r = await runTool(handlers, 'memory_search', { query: '自定义作用域内容', scope: '项目笔记' })
check('自定义作用域能检索到', r.structuredContent.count === 1, `count=${r.structuredContent.count}`)

// ── schema 自检 ────────────────────────────────────────────────
console.log('\n[9] schema 自检')
check('5 个工具', TOOL_NAMES.length === 5, TOOL_NAMES.join(','))
check('memory_save.content 必填', TOOL_SCHEMAS.memory_save.required.includes('content'))
check('memory_save.kind 默认 note', TOOL_SCHEMAS.memory_save.properties.kind.default === 'note')
check('memory_save.kind 6 个枚举', TOOL_SCHEMAS.memory_save.properties.kind.enum.length === 6)
check('memory_save.importance 0~1',
  TOOL_SCHEMAS.memory_save.properties.importance.minimum === 0
  && TOOL_SCHEMAS.memory_save.properties.importance.maximum === 1)
check('memory_search.topK 默认 5 / 1~20',
  TOOL_SCHEMAS.memory_search.properties.topK.default === 5
  && TOOL_SCHEMAS.memory_search.properties.topK.minimum === 1
  && TOOL_SCHEMAS.memory_search.properties.topK.maximum === 20)
check('memory_list.limit 默认 50 / 1~200',
  TOOL_SCHEMAS.memory_list.properties.limit.default === 50
  && TOOL_SCHEMAS.memory_list.properties.limit.minimum === 1
  && TOOL_SCHEMAS.memory_list.properties.limit.maximum === 200)
check('memory_get.ids 必填 + maxItems 50',
  TOOL_SCHEMAS.memory_get.required.includes('ids') && TOOL_SCHEMAS.memory_get.properties.ids.maxItems === 50)
check('memory_forget 同时有 id 与 query', TOOL_SCHEMAS.memory_forget.properties.id !== undefined
  && TOOL_SCHEMAS.memory_forget.properties.query !== undefined)
check('所有 schema 都不带 strict additionalProperties',
  Object.values(TOOL_SCHEMAS).every((s) => s.additionalProperties === undefined))

// ── 汇总 ────────────────────────────────────────────────────────
console.log(`\n共 ${results.length} 项检查,通过 ${results.length - failures} 项,失败 ${failures} 项。`)
if (failures > 0) {
  console.log('\n失败项:')
  for (const x of results.filter((y) => !y.ok)) console.log(`  - ${x.name}\n      ${x.detail}`)
}
process.exit(failures > 0 ? 1 : 0)
