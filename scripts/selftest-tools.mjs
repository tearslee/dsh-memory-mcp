/**
 * 工具层单元自测 —— 不依赖 MCP SDK,也不依赖存储层。
 * 用一个**内存版**的假 store 验证参数校验、scope 决策与渲染。
 *
 * 用法:node scripts/selftest-tools.mjs
 */
import { join } from 'node:path'

import { normalizeProjectPath, projectScopeKey, createTools, runTool, TOOL_NAMES, TOOL_SCHEMAS, STATE_TTL_MS } from '../src/tools.js'

/**
 * 路径样例**必须按平台取**。
 *
 * `normalizeProjectPath()` 用的是 `node:path`,语义天然跟着平台走:Windows 上
 * `D:\dev\app` 是绝对路径、盘符会被统一大写;POSIX 上 `\` 只是**普通文件名字符**,
 * `D:\dev\app` 是相对路径,`d:` 和 `D:` 是两个不同目录。
 *
 * 所以「用 Windows 盘符字面量断言 POSIX 行为」的测试只在开发机上成立 ——
 * 在 `ubuntu-latest` 上会成片假失败。这里取平台对应的绝对路径,
 * 让断言保持**同一个意图**(去尾分隔符 / 折叠 ../ / 相对解析 / 大小写),
 * 而不是把 Windows 语义硬编码成唯一正确答案。
 *
 * `otherAlt` 用来验「同一目录不同写法归一」:Windows 盘符大小写不敏感
 * (`d:` ≡ `D:`,由 `normalizeProjectPath` 显式折叠),POSIX 上用 `//` 与 `/` 等价写法。
 */
const WIN = process.platform === 'win32'
const P = WIN
  ? {
      app: 'D:\\dev\\app', appTrail: 'D:\\dev\\app\\', appParent: '..\\other',
      other: 'D:\\dev\\other', otherTrail: 'D:\\dev\\other\\', otherAlt: 'd:\\dev\\other',
      proj: 'D:\\dev\\proj', elsewhere: 'C:\\x',
    }
  : {
      app: '/srv/dev/app', appTrail: '/srv/dev/app/', appParent: '../other',
      other: '/srv/dev/other', otherTrail: '/srv/dev/other/', otherAlt: '//srv//dev/other',
      proj: '/srv/dev/proj', elsewhere: '/srv/x',
    }

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
      ...(input.expiredAt ? { expiredAt: input.expiredAt } : {}),
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

  /** 与 SharedStore.identityMatches 同语义(两段/三段头兼容)。 */
  identityMatches(header) {
    return this.vecIdentity ? !header || header.split('\t')[0] === this.vecIdentity.split('\t')[0] : true
  }
}

console.log('═'.repeat(70))
console.log('  工具层单元自测(不依赖 MCP SDK / 存储层)')
console.log('═'.repeat(70))

// ── 路径归一化 ──────────────────────────────────────────────────
console.log('\n[1] 路径归一化')
check('绝对路径去掉末尾分隔符', normalizeProjectPath(P.appTrail, P.elsewhere) === P.app, normalizeProjectPath(P.appTrail, P.elsewhere))
if (WIN) {
  // 盘符大小写折叠只对 Windows 路径有意义(POSIX 上 `c:` 是合法但**不同**的名字)。
  check('盘符统一大写', normalizeProjectPath('c:\\dev\\app', 'C:\\x') === 'C:\\dev\\app', normalizeProjectPath('c:\\dev\\app', 'C:\\x'))
  check('折叠 . 与 ..', normalizeProjectPath('D:\\dev\\app\\..\\app', 'C:\\x') === 'D:\\dev\\app', normalizeProjectPath('D:\\dev\\app\\..\\app', 'C:\\x'))
} else {
  check('折叠 . 与 ..', normalizeProjectPath('/srv/dev/app/../app', '/srv/x') === '/srv/dev/app', normalizeProjectPath('/srv/dev/app/../app', '/srv/x'))
}check('相对路径按 base 解析', normalizeProjectPath('sub', P.app) === join(P.app, 'sub'), normalizeProjectPath('sub', P.app))
check('相对路径按 base 解析(带 ..)', normalizeProjectPath(P.appParent, P.app) === P.other, normalizeProjectPath(P.appParent, P.app))
check('projectScopeKey 形状', projectScopeKey(P.app) === `project:${P.app}`, projectScopeKey(P.app))

// ── scope 决策 ──────────────────────────────────────────────────
console.log('\n[2] scope 决策')
const PROJECT = P.proj
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
r = await runTool(handlers, 'memory_save', { content: 'path 作用域测试', path: P.other })
check('memory_save path= → project:<绝对路径>', r.structuredContent.scope === `project:${P.other}`, `scope=${r.structuredContent.scope}`)

// path 归一化:同一目录不同写法必须落到同一个 scope
r = await runTool(handlers, 'memory_save', { content: 'path 归一化 A', path: P.otherTrail })
const scopeA = r.structuredContent.scope
r = await runTool(handlers, 'memory_save', { content: 'path 归一化 B', path: P.otherAlt })
check('同一目录的不同写法归一到同一个 scope', scopeA === r.structuredContent.scope, `${scopeA} vs ${r.structuredContent.scope}`)

// path + scope='global' → 冲突
r = await runTool(handlers, 'memory_save', { content: '冲突测试', path: P.other, scope: 'global' })
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
check('global 里那条还在', r.content[0].text.includes('批量删除目标内容'),
  r.content[0].text.slice(0, 120))

// ── 自定义作用域 ────────────────────────────────────────────────
console.log('\n[8] 自定义作用域')
r = await runTool(handlers, 'memory_save', { content: '自定义作用域内容', scope: '项目笔记' })
check('自定义名被规范化(小写)', r.structuredContent.scope === '项目笔记', `scope=${r.structuredContent.scope}`)
r = await runTool(handlers, 'memory_search', { query: '自定义作用域内容', scope: '项目笔记' })
check('自定义作用域能检索到', r.structuredContent.count === 1, `count=${r.structuredContent.count}`)

// ── schema 自检 ────────────────────────────────────────────────
console.log('\n[9] schema 自检')
check('7 个工具', TOOL_NAMES.length === 7, TOOL_NAMES.join(','))
check('包含项目索引工具', TOOL_NAMES.includes('memory_index') && TOOL_NAMES.includes('memory_index_status'))
check('memory_save.content 必填', TOOL_SCHEMAS.memory_save.required.includes('content'))
check('memory_save.kind 默认 note', TOOL_SCHEMAS.memory_save.properties.kind.default === 'note')
check('memory_save.kind 7 个枚举', TOOL_SCHEMAS.memory_save.properties.kind.enum.length === 7)
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
check('memory_index 默认 dryRun=true', TOOL_SCHEMAS.memory_index.properties.dryRun.default === true)
check('memory_index 写入必须 confirm', TOOL_SCHEMAS.memory_index.properties.confirm.default === false)
check('memory_index.sources 枚举正确',
  JSON.stringify(TOOL_SCHEMAS.memory_index.properties.sources.items.enum) === JSON.stringify(['daily', 'detail', 'rules']))
check('所有 schema 都不带 strict additionalProperties',
  Object.values(TOOL_SCHEMAS).every((s) => s.additionalProperties === undefined))

// ── 载荷不重复（2026-10-26 契约：正文只在文本通道出现一次，且是摘要）──────
// 旧版同一条正文在一次调用里出现三遍：content[0].text / structuredContent.message /
// records[].content，客户端全塞进上下文 = 为一条记忆付三份 token。
// 放在最后：新增记录会推进假 store 的 id 序列，不能插在靠 id 前缀断言的用例之前。
console.log('\n[10] 载荷不重复')
const LONG_BODY = `长正文摘要测试 ${'甲'.repeat(400)}`
await runTool(handlers, 'memory_save', { content: LONG_BODY, scope: 'project', kind: 'note' })
const sumRes = await runTool(handlers, 'memory_search', { query: '长正文摘要测试', scope: 'project' })
check('检索 structuredContent 不再带 message（与 text 重复）',
  sumRes.structuredContent.message === undefined, `message=${JSON.stringify(sumRes.structuredContent.message)?.slice(0, 40)}`)
check('检索记录不再带 content 字段（全文走 memory_get）',
  sumRes.structuredContent.records.every((x) => x.content === undefined),
  JSON.stringify(Object.keys(sumRes.structuredContent.records[0] ?? {})))
const longRec = sumRes.structuredContent.records.find((x) => x.contentLength === LONG_BODY.length)
check('检索记录带 contentLength（用于判断要不要 memory_get）', !!longRec,
  JSON.stringify(sumRes.structuredContent.records.map((x) => x.contentLength)))
check('摘要只在文本通道出现一次，结构化通道不带 summary',
  longRec?.summary === undefined, JSON.stringify(Object.keys(longRec ?? {})))
check('文本输出里是摘要而非全文', !sumRes.content[0].text.includes('甲'.repeat(200)),
  `text 长度=${sumRes.content[0].text.length}`)
check('文本输出含截断后的摘要', sumRes.content[0].text.includes('甲'.repeat(120)), '')
check('短正文不截断、不加省略号',
  (await runTool(handlers, 'memory_search', { query: 'TypeScript 严格模式', scope: 'project' }))
    .content[0].text.includes('项目里的记忆:前端统一使用 TypeScript 严格模式'), '')
const listSum = await runTool(handlers, 'memory_list', { scope: 'project' })
check('列表结构化通道同样不带 content / summary',
  listSum.structuredContent.records.every((x) => x.content === undefined && x.summary === undefined),
  JSON.stringify(Object.keys(listSum.structuredContent.records[0] ?? {})))
check('列表不再带 message', listSum.structuredContent.message === undefined, '')
// 假 store 的 id 全部共享前 8 位（00000000-…），前缀会命中多条 → 这里用完整 id。
const getFull = await runTool(handlers, 'memory_get', { ids: [longRec.id] })
check('memory_get 仍返回完整正文（摘要不可替代全文）',
  getFull.structuredContent.records[0]?.content === LONG_BODY,
  `取回长度=${getFull.structuredContent.records[0]?.content?.length}`)

// ── 与上游 0.26 对齐：supersedes / state / 退役过滤 / custom: 前缀 ─────────
console.log('\n[11] 上游 0.26 对齐')
const aligned = new FakeStore()
const seededAt = Date.now()
const seed = (id, scope, content, extra = {}) => aligned.records.set(id, {
  id, scope, kind: 'fact', content, tags: [], source: { origin: 'explicit' },
  createdAt: seededAt, updatedAt: seededAt, lastAccessedAt: seededAt, accessCount: 0, importance: 0.5, ...extra,
})
const oldId = 'aaaaaaaa-1111-4111-8111-111111111111'
const crossId = 'bbbbbbbb-2222-4222-8222-222222222222'
const expiredId = 'cccccccc-3333-4333-8333-333333333333'
seed(oldId, 'global', '旧结论：部署使用蓝绿方案 alpha')
seed(crossId, projectKey, '跨作用域旧结论 gamma')
seed(expiredId, 'global', '过期状态 delta', { kind: 'state', expiredAt: seededAt - 1000 })
seed('dddddddd-4444-4444-8444-444444444444', 'global', '同前缀 e1')
seed('dddddddd-5555-4555-8555-555555555555', 'global', '同前缀 e2')
const alignedHandlers = createTools({ store: aligned, config: { projectBasePath: PROJECT, defaultSaveScope: 'global' } })

let ar = await runTool(alignedHandlers, 'memory_save', { content: '新结论：部署改用滚动发布 beta', supersedes: 'aaaaaaaa' })
const savedSupersedes = aligned.records.get(ar.structuredContent.id)?.supersedes
check('supersedes 短前缀 → 落盘完整 UUID', savedSupersedes === oldId, `落盘=${savedSupersedes}`)

ar = await runTool(alignedHandlers, 'memory_save', { content: '未知目标测试', supersedes: 'ffffffff' })
check('supersedes 未知前缀 → SUPERSEDES_UNKNOWN',
  ar.isError === true && ar.structuredContent.code === 'SUPERSEDES_UNKNOWN', `code=${ar.structuredContent.code}`)

ar = await runTool(alignedHandlers, 'memory_save', { content: '跨作用域目标测试', supersedes: 'bbbbbbbb' })
check('supersedes 跨作用域 → SUPERSEDES_UNKNOWN',
  ar.isError === true && ar.structuredContent.code === 'SUPERSEDES_UNKNOWN', `code=${ar.structuredContent.code}`)

ar = await runTool(alignedHandlers, 'memory_save', { content: '歧义前缀测试', supersedes: 'dddddddd' })
check('supersedes 歧义前缀 → SUPERSEDES_AMBIGUOUS',
  ar.isError === true && ar.structuredContent.code === 'SUPERSEDES_AMBIGUOUS', `code=${ar.structuredContent.code}`)

ar = await runTool(alignedHandlers, 'memory_save', { content: '临时状态 zeta', kind: 'state' })
const stateRec = aligned.records.get(ar.structuredContent.id)
check('state 默认 7 天 TTL', Math.abs(stateRec.expiredAt - (Date.now() + STATE_TTL_MS)) < 5000,
  `expiredAt-now=${stateRec.expiredAt - Date.now()}`)
check('state 可被 memory_list 的 kind 过滤', (await runTool(alignedHandlers, 'memory_list', { scope: 'global', kind: 'state' }))
  .structuredContent.records.some((x) => x.id === ar.structuredContent.id), '')

const retiredSearch = await runTool(alignedHandlers, 'memory_search', { query: '蓝绿方案 alpha', scope: 'global' })
check('检索默认隐藏被取代记录',
  !retiredSearch.structuredContent.records.some((x) => x.id === oldId),
  JSON.stringify(retiredSearch.structuredContent.records.map((x) => x.id)))
const historySearch = await runTool(alignedHandlers, 'memory_search', { query: '蓝绿方案 alpha', scope: 'global', includeSuperseded: true })
check('includeSuperseded=true 可回历史',
  historySearch.structuredContent.records.some((x) => x.id === oldId),
  JSON.stringify(historySearch.structuredContent.records.map((x) => x.id)))
check('检索默认隐藏已过期记录',
  !(await runTool(alignedHandlers, 'memory_search', { query: '过期状态 delta', scope: 'global' }))
    .structuredContent.records.some((x) => x.id === expiredId), '')

const alignedList = await runTool(alignedHandlers, 'memory_list', { scope: 'global' })
check('列表默认隐藏被取代记录', !alignedList.structuredContent.records.some((x) => x.id === oldId), '')
check('列表默认隐藏已过期记录', !alignedList.structuredContent.records.some((x) => x.id === expiredId), '')
check('memory_get 仍可取回被取代/过期记录(历史)',
  (await runTool(alignedHandlers, 'memory_get', { ids: [oldId, expiredId] }))
    .structuredContent.records.length === 2, '')

ar = await runTool(alignedHandlers, 'memory_save', { content: '自定义作用域测试', scope: 'custom:Handbook' })
check('custom:<name> 折成裸名', ar.structuredContent.scope === 'handbook', `scope=${ar.structuredContent.scope}`)
ar = await runTool(alignedHandlers, 'memory_save', { content: '非法自定义前缀', scope: 'custom:global' })
check('custom:global 仍非法', ar.isError === true && ar.structuredContent.code === 'SCOPE_INVALID', `code=${ar.structuredContent.code}`)

// ── 汇总 ────────────────────────────────────────────────────────
console.log(`\n共 ${results.length} 项检查,通过 ${results.length - failures} 项,失败 ${failures} 项。`)
if (failures > 0) {
  console.log('\n失败项:')
  for (const x of results.filter((y) => !y.ok)) console.log(`  - ${x.name}\n      ${x.detail}`)
}
process.exit(failures > 0 ? 1 : 0)
