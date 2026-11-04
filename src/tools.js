/**
 * 工具层 —— 纯函数 + 明确 schema,**不 import MCP SDK**(保持可单测)。
 *
 * 五个工具:memory_save / memory_search / memory_list / memory_get / memory_forget。
 * schema 对齐上游 @restregular/dsh-memory 0.7.2 的 `lib/tools/index.js`,
 * 但补上了上游漏注册的 memory_get,并按 MCP 的场景改了 scope 语义(见下)。
 *
 * ── MCP 的 scope 决策(与 DSH 的差异)────────────────────────────────
 * DSH 里 `tools.defaultScope` 是 `session`,但**跨 IDE 的 session id 完全不同**
 * (Trae / WorkBuddy / DSH 各有各的会话 id),session scope 对"跨 agent 共享"毫无意义。
 * 所以本 MCP:
 *   - 跨 agent 真正共享的只有 **global** 与 **project:<绝对路径>**;
 *   - `memory_save` 省略 scope → **global**(可被所有 IDE 看到);
 *   - `memory_search` 省略 scope → **当前项目 + global**;
 *   - `memory_list`   省略 scope → **当前项目 + global**;
 *   - `memory_forget` 用 query 时省略 scope → **当前项目**(比 session 安全,不会误删别人的);
 *   - 裸 `session` → 当前项目(与上游"拿不到会话就回退 project"同语义;MCP 没有可共享的会话 id);
 *   - 显式 `session:<id>` → 原样保留(可以 pin 某个会话作用域);
 *   - `all` / `*` → 所有已发现作用域,**仅读**。
 * 任何不合法的作用域名一律报错,**绝不静默回退**。
 *
 * Copyright (c) 2026 restregular
 * SPDX-License-Identifier: MIT
 */

import { isAbsolute, normalize, resolve } from 'node:path'
import { buildStats, cosine, hasStrongHit, lexicalScore, normalizeInPlace, recordScore, tokenize } from './scoring.js'
import { normalizeScopeInput, scopeTier } from './scope.js'
import {
  applyIndexPlan,
  buildIndexPlan,
  defaultStatusSince,
  inspectIndex,
  normalizeIndexSources,
  normalizeSince,
} from './workbuddy-index.js'

/** 记忆种类(与上游 0.26 一致)。 */
export const KINDS = ['fact', 'decision', 'preference', 'procedure', 'note', 'rule', 'state']
/** kind=state 的默认有效期:上游默认 7 天。 */
export const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 检索参数默认值 / 范围(与上游一致)。 */
export const TOPK_DEFAULT = 5
export const TOPK_MIN = 1
export const TOPK_MAX = 20
export const LIMIT_DEFAULT = 50
export const LIMIT_MIN = 1
export const LIMIT_MAX = 200
/** memory_get 最多取多少个 id。 */
export const GET_MAX_IDS = 50
/** 检索的候选上限(先取 recallN 条,再按 topK 截断)。 */
export const RECALL_N = 30
/** 词法命中的地板:global 一档,其余一档。 */
export const GLOBAL_THRESHOLD = 0.12
export const PROJECT_THRESHOLD = 0.1
/** 只有弱命中(单字 CJK)时要求的更高地板。 */
export const REAL_HIT_FLOOR = 0.25
/** 时间衰减半衰期(天)。 */
export const HALF_LIFE_DAYS = 30
/** 向量相似度下限。 */
export const VECTOR_MIN_SCORE = 0.5
/** 熔断阈值:连续失败后指数退避。 */
export const MAX_BACKOFF_MS = 30_000

/** 8 位 id 前缀 —— 展示与 memory_get 的定位键。 */
export function shortId(id) {
  return typeof id === 'string' ? id.slice(0, 8) : ''
}

/**
 * 检索/列表结果里正文的摘要长度上限。
 *
 * 与上游 DSH 插件 0.16.0 的行为对齐(`memory_search` 不再返回正文,只回 id + 摘要,
 * 正文统一走 `memory_get`)。理由不是"省字符"而是**同一份正文会在一次调用里出现三遍**:
 * `content[0].text`、`structuredContent.message`、`structuredContent.records[].content` ——
 * 客户端把这三处都塞进上下文,等于为一条记忆付三份 token。
 */
export const SUMMARY_CHARS = 160

/** 把正文压成摘要:空白折叠 + 截断,超长时加省略号让 agent 知道该去 `memory_get`。 */
export function summarize(content) {
  const flat = String(content ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= SUMMARY_CHARS ? flat : `${flat.slice(0, SUMMARY_CHARS)}…`
}

function round4(n) {
  return Math.round(Number(n) * 10_000) / 10_000
}

/** 统一的工具错误(带 code,渲染成给人看的文本而不是抛栈)。 */
export class ToolError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ToolError'
    this.code = code
  }
}

// ────────────────────────────────────────────────────────────────────
// 路径与 scope 归一化
// ────────────────────────────────────────────────────────────────────

/**
 * 归一化工作区路径 —— **必须**归一化,否则同一个目录会分裂成两个 scope。
 *
 *   - 绝对路径:原样使用(但折叠 `.` / `..`、去掉末尾分隔符);
 *   - 相对路径:按 base(DSH_MEMORY_PROJECT / --project,都没有则 process.cwd())解析;
 *   - Windows 下盘符统一大写(`c:\x` 与 `C:\x` 是同一个目录)。
 */
export function normalizeProjectPath(raw, base) {
  const value = String(raw ?? '').trim()
  if (value === '') throw new ToolError('PATH_INVALID', 'path 不能为空')
  const baseDir = typeof base === 'string' && base.trim() !== '' ? base : process.cwd()
  const full = isAbsolute(value) ? value : resolve(baseDir, value)
  let normalized = normalize(full)
  // 去掉末尾分隔符(根目录 `C:\` 保留成 `C:\`)
  normalized = normalized.replace(/[\\/]+$/u, '')
  if (normalized === '') normalized = full
  if (/^[A-Za-z]:$/u.test(normalized)) normalized = `${normalized}\\`
  if (/^[a-z]:/u.test(normalized)) normalized = `${normalized[0].toUpperCase()}${normalized.slice(1)}`
  return normalized
}

/** `project:<绝对路径>` —— 项目作用域的键。 */
export function projectScopeKey(absPath) {
  return `project:${absPath}`
}

/**
 * 作用域键的展示标签:项目显示成路径,其余原样。
 */
export function scopeLabel(scope) {
  if (typeof scope !== 'string') return String(scope)
  if (scope.startsWith('project:')) return scope.slice('project:'.length)
  return scope
}

// ────────────────────────────────────────────────────────────────────
// store 适配层
// ────────────────────────────────────────────────────────────────────

/**
 * 把 store 的返回值收敛成统一形状 —— 上游/本包在细节上可能返回 boolean 或对象,
 * 这里做一次归一,免得工具层到处写分支。
 */
function adaptStore(store) {
  return {
    raw: store,

    save(input) {
      const result = store.save(input)
      if (result && typeof result === 'object' && result.record) {
        return { deduped: result.deduped === true, record: result.record }
      }
      if (Array.isArray(result) && result[0]?.record) {
        return { deduped: result[0].deduped === true, record: result[0].record }
      }
      throw new ToolError('STORE_ERROR', '存储层返回了无法识别的 save 结果')
    },

    deleteById(id) {
      const result = store.deleteById(id)
      if (result && typeof result === 'object') {
        return { deleted: result.deleted !== false, record: result.record }
      }
      return { deleted: result === true, record: undefined }
    },

    deleteByQuery(scopeKey, query) {
      const result = store.deleteByQuery(scopeKey, query)
      if (result && typeof result === 'object') {
        const deleted = typeof result.deleted === 'number' ? result.deleted : (result.ids?.length ?? 0)
        return { deleted, ids: Array.isArray(result.ids) ? result.ids : [] }
      }
      if (typeof result === 'number') return { deleted: result, ids: [] }
      return { deleted: result === true ? 1 : 0, ids: [] }
    },

    listRecords(opts) {
      const result = store.listRecords(opts)
      return Array.isArray(result) ? result : (result?.records ?? [])
    },

    allScopeKeys() {
      const result = store.allScopeKeys()
      return Array.isArray(result) ? result : []
    },

    /**
     * 读 `.vec` 边车。归一化成 `{ identity, model, dims, vectors: Map<string, Float32Array> }`。
     * store-layer 返回 `{ identity, model, dims, vectors }`;这里也吃掉 Map / 数组等其它形态。
     */
    readSidecar(scopeKey) {
      let result
      try {
        result = store.readSidecar(scopeKey)
      } catch {
        return null
      }
      if (!result) return null
      if (result instanceof Map) return { identity: '', model: '', dims: 0, vectors: result }
      const rawVectors = result.vectors ?? result.entries ?? result.records
      const vectors = rawVectors instanceof Map
        ? rawVectors
        : new Map(Object.entries(rawVectors ?? {}))
      return {
        identity: typeof result.identity === 'string' ? result.identity : '',
        model: typeof result.model === 'string' ? result.model : '',
        dims: typeof result.dims === 'number' ? result.dims : 0,
        vectors,
      }
    },

    appendSidecar(scopeKey, id, vec) {
      store.appendSidecar(scopeKey, id, vec)
    },

    /**
     * `.vec` 身份头是否匹配。
     * 委托给存储层(与上游同一套两段/三段兼容语义);缺失时退化为不校验身份。
     */
    identityMatches(header) {
      if (typeof store.identityMatches === 'function') return store.identityMatches(header)
      return true
    },

    /**
     * 触达计数(检索命中后 accessCount+1 / lastAccessedAt 刷新)。
     *
     * 优先用 `touchMany(ids)` —— 存储层会按 scope 分组,每个 scope 只取一次锁、
     * 只重写一次文件。循环调 `touch()` 等于每条命中都重写一次整个 scope 文件,
     * 在搜索路径上不可接受。
     */
    touchMany(ids) {
      if (!Array.isArray(ids) || ids.length === 0) return
      if (typeof store.touchMany === 'function') {
        try {
          store.touchMany(ids)
        } catch {
          // 触达计数是尽力而为的,失败不影响检索结果
        }
        return
      }
      if (typeof store.touch === 'function') {
        for (const id of ids) {
          try {
            store.touch(id)
          } catch {
            // 同上
          }
        }
      }
    },
  }
}

// ────────────────────────────────────────────────────────────────────
// 工具 schema
// ────────────────────────────────────────────────────────────────────

const SCOPE_HELP =
  "作用域。省略时的默认行为见工具说明。'global'=所有项目共享;'project'=当前工作区;"
  + "'project:<绝对路径>'=指定工作区;'session:<id>'=指定会话作用域(原样保留);"
  + "其他任意名称=自定义作用域(小写折叠、内部空白折叠为单空格、1~64 字符、"
  + "禁 ':' '/' '\\' '..' 与保留名 global/project/session/all);"
  + "也接受展示名 custom:<name> 并自动折成裸名。读取时可用 'all' 跨所有作用域。"

const KIND_HELP = '记忆种类:fact / decision / preference / procedure / note / rule / state'
  + '(state 默认 7 天后过期,过期记录默认不出现在检索/列表里)。'

/** 工具的 JSON Schema —— 前五个与上游对齐，后两个是本仓库的项目索引扩展。 */
export const TOOL_SCHEMAS = {
  memory_save: {
    type: 'object',
    properties: {
      content: { type: 'string', description: '记忆正文:一句自包含的陈述句,不依赖上下文也能读懂。必填。' },
      scope: {
        type: 'string',
        description:
          `${SCOPE_HELP}\n`
          + '【MCP 默认】省略 scope 时写入 **global** —— 跨 IDE(DSH / Trae / WorkBuddy)共享的只有 global 与 project。'
          + `可用环境变量 DSH_MEMORY_SCOPE_ALL=true 把默认改成 project(当前工作区)。\n`
          + '配合 path 一起给时,scope 会被当作该工作区作用域的**显示名(别名)**。',
      },
      path: {
        type: 'string',
        description:
          '工作区目录(绝对路径或相对路径)。给出后写入 project:<解析后的绝对路径>,'
          + '相对路径按 DSH_MEMORY_PROJECT / --project 解析(都没有则按进程工作目录)。'
          + '同一目录必须只有一种写法,本工具会自动归一化(折叠 . 与 ..、去末尾分隔符)。',
      },
      kind: { type: 'string', enum: KINDS, default: 'note', description: KIND_HELP },
      tags: { type: 'array', items: { type: 'string' }, description: '自由标签,便于人工归类。' },
      importance: { type: 'number', minimum: 0, maximum: 1, description: '重要度 0~1,越大越优先被召回。越界会报错。' },
      supersedes: { type: 'string', description: '被本条取代/纠正的记忆 id(可写 8 位前缀,写入时解析成完整 id;目标必须与本条同作用域)。' },
    },
    required: ['content'],
  },

  memory_search: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索关键词或一句话描述。必填。' },
      scope: {
        type: 'string',
        description:
          `${SCOPE_HELP}\n`
          + '【MCP 默认】省略 scope 时在**当前工作区 + global**两个作用域里检索。'
          + "写 'all' 则跨所有已发现的作用域检索。",
      },
      topK: { type: 'number', minimum: TOPK_MIN, maximum: TOPK_MAX, default: TOPK_DEFAULT, description: '返回条数,1~20,默认 5。' },
      includeSuperseded: { type: 'boolean', default: false, description: '默认 false,已被取代的旧记录不返回;true 时一并返回(历史核对)。' },
    },
    required: ['query'],
  },

  memory_list: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        description:
          `${SCOPE_HELP}\n`
          + '【MCP 默认】省略 scope 时列出**当前工作区 + global**。'
          + "写 'all' 则列出所有已发现的作用域。",
      },
      kind: { type: 'string', description: `按种类过滤。${KIND_HELP}` },
      limit: { type: 'number', minimum: LIMIT_MIN, maximum: LIMIT_MAX, default: LIMIT_DEFAULT, description: '返回条数,1~200,默认 50。' },
    },
    required: [],
  },

  memory_get: {
    type: 'object',
    properties: {
      ids: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: GET_MAX_IDS,
        description:
          '记忆 id 列表(可写检索/列表结果里的 8 位前缀)。必填。会自动去重,最多取前 50 个。',
      },
    },
    required: ['ids'],
  },

  memory_forget: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '要删除的精确记忆 id(或 8 位前缀)。与 query **二选一**。' },
      query: { type: 'string', description: '按内容子串删除。与 id **二选一**。' },
      scope: {
        type: 'string',
        description:
          `${SCOPE_HELP}\n`
          + '【MCP 默认】用 query 删除且省略 scope 时,只作用于**当前工作区**(不会误删 global 或别人的作用域)。'
          + "用 id 删除时忽略本参数(精确 id 跨作用域唯一)。'all' 不能与 query 同用。",
      },
    },
    required: [],
  },

  memory_index: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description:
          '项目根目录（绝对路径或相对当前项目解析）。索引永远只写 project:<解析后的绝对路径>，绝不写 global。'
          + '省略时使用当前 --project / DSH_MEMORY_PROJECT。',
      },
      sources: {
        type: 'array',
        items: { type: 'string', enum: ['daily', 'detail', 'rules'] },
        description: '要索引的来源，默认 ["daily"]。detail 会跳过 00-done-log.md；secrets.local.md 永远跳过。',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: '只索引指定文件（相对于 .workbuddy/memory 或项目根目录）。与 sources 一起给时以 files 为准。',
      },
      since: { type: 'string', description: '只索引日期 >= YYYY-MM-DD 的日报；detail/rules 不受日期过滤。' },
      dryRun: { type: 'boolean', default: true, description: '默认 true，只返回计划不写入。必须显式 false 且 confirm=true 才写。' },
      confirm: { type: 'boolean', default: false, description: '写入门禁。dryRun=false 时必须同时 confirm=true。' },
      maxChars: { type: 'number', minimum: 0, description: '单条正文上限；0 表示不截断。' },
    },
    required: [],
  },

  memory_index_status: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '项目根目录；省略时使用当前项目。' },
      sources: {
        type: 'array',
        items: { type: 'string', enum: ['daily', 'detail', 'rules'] },
        description: '检查范围，默认 daily + detail + rules。',
      },
      since: { type: 'string', description: '只检查日期 >= YYYY-MM-DD 的日报。' },
    },
    required: [],
  },
}

/** 工具描述 —— 写给 agent 看,说明什么时候该用。 */
export const TOOL_DESCRIPTIONS = {
  memory_save:
    '保存一条长期记忆(事实 / 决策 / 偏好 / 做法 / 规则),供以后所有会话与其它 IDE(DSH、Trae、WorkBuddy)读取。'
    + '当用户表达了值得长期保留的信息(技术决策、约定、偏好、"以后都这么做")时用它;'
    + '不要用它存一次性的中间结果。\n'
    + '【默认 scope】省略 scope 时写入 **global**,这样 Trae / WorkBuddy / DSH 三个 IDE 共享同一份记忆。'
    + '想只对当前工作区生效,显式传 scope="project" 或 path="<工作区目录>"。',

  memory_search:
    '按关键词或语义检索已保存的记忆(词法 + 本地向量混合召回)。'
    + '在开始新任务、或者需要回忆"之前定的规矩是什么"时先调用它。'
    + '只回 id + 摘要(前 160 字);要全文用 memory_get 传 8 位 id。\n'
    + '【默认 scope】省略 scope 时在**当前工作区 + global**里检索;'
    + "写 scope=\"all\" 跨所有已发现的作用域检索(只读)。",

  memory_list:
    '列出已保存的记忆,按最近更新优先。'
    + '当你想快速浏览"到底存了些什么"、或者要找一条记忆的 id 时用它(比 search 更确定、更省)。'
    + '同样只回 id + 摘要,全文用 memory_get。\n'
    + '【默认 scope】省略 scope 时列出**当前工作区 + global**;'
    + "写 scope=\"all\" 列出所有作用域。",

  memory_get:
    '按 id 取回记忆的具体内容(可写检索/列表结果里的 8 位前缀)。'
    + '这是快速路径:已经知道 id 时用它,不要为此再跑一次 search。\n'
    + 'id 列表会自动去重,最多取前 50 个。',

  memory_forget:
    '删除记忆:按 id 精确删,或按 query 子串批量删。两者**二选一**(都不给或都给都会报错)。\n'
    + '【默认 scope】用 query 删除且省略 scope 时只作用于**当前工作区**,不会误删 global 或别的 IDE 写下的内容。'
    + '删除是不可撤销的,调用前请先向用户确认。',

  memory_index:
    '把项目 `.workbuddy/memory` 的日报 / detail / rules 按 Markdown 二级章节建成 dsh project 派生索引。'
    + '只写 project:<项目路径>，绝不写 global；每条带来源 + hash，源变化时用完整 UUID supersedes。'
    + '默认 dryRun=true，先看计划；确认后传 dryRun=false + confirm=true。',

  memory_index_status:
    '只读检查项目索引是否新鲜：列出未索引/需替换章节、孤儿记录、源文件缺失与最近源日期。'
    + '不写 store，适合收尾或接手前判断「索引是否停在旧日期」。',
}

/** 工具清单(顺序即 MCP tools/list 里的顺序)。 */
export const TOOL_NAMES = [
  'memory_save', 'memory_search', 'memory_list', 'memory_get', 'memory_forget',
  'memory_index', 'memory_index_status',
]

/**
 * 输出 schema —— 故意**宽松**。
 *
 * MCP SDK 的 Client 会用 AJV 校验 `structuredContent` 是否符合工具声明的
 * `outputSchema`(不匹配就抛 InvalidParams)。所以这里只声明最核心的字段,
 * 且**不写 `additionalProperties: false`** —— 否则工具多返回一个字段就会被客户端拒掉。
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '是否成功。false 表示参数校验或业务错误。' },
    code: { type: 'string', description: '错误码(成功时通常不出现)。' },
    message: { type: 'string', description: '给人看的说明。' },
  },
  required: ['ok'],
}

// ────────────────────────────────────────────────────────────────────
// 参数校验
// ────────────────────────────────────────────────────────────────────

function requireString(value, code, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolError(code, `${field} 必须是非空字符串`)
  }
  return value
}

function optionalNumber(value, { field, min, max, code }) {
  if (value === undefined || value === null) return undefined
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) throw new ToolError(code, `${field} 必须是数字`)
  if (n < min || n > max) throw new ToolError(code, `${field} 必须在 ${min}~${max} 之间(收到 ${n})`)
  return n
}

// ────────────────────────────────────────────────────────────────────
// 工具实现
// ────────────────────────────────────────────────────────────────────

/**
 * 构造五个工具的执行器。
 *
 * @param {object} deps
 * @param {object} deps.store  SharedStore 实例
 * @param {object} deps.config { projectBasePath, defaultSaveScope, vector }
 * @param {object} [deps.names] ScopeNames 实例(用于工作区别名)
 */
export function createTools(deps) {
  const store = adaptStore(deps.store)
  const config = deps.config ?? {}
  const vector = config.vector ?? null
  const names = deps.names ?? null

  /** 当前项目的作用域键。 */
  const currentProjectScope = () => projectScopeKey(normalizeProjectPath(config.projectBasePath ?? process.cwd(), process.cwd()))

  /** 默认读取集合:当前项目 + global。 */
  const defaultReadScopes = () => {
    const set = new Set([currentProjectScope(), 'global'])
    return [...set]
  }

  /**
   * 把工具传入的 scope 字符串解析成具体的作用域键。
   *
   * @param {string|undefined} raw
   * @param {'read'|'write'} mode
   * @returns {{ all: true } | { scope: string }}
   */
  function resolveScope(raw, mode) {
    const normalized = normalizeScopeInput(raw)
    if (!normalized.ok) {
      throw new ToolError('SCOPE_INVALID', `scope 无效:${normalized.message}。`
        + '可用值:global / project / project:<绝对路径> / session:<id> / 任意自定义名;读取时还可用 all。')
    }
    if (normalized.kind === 'all') {
      if (mode === 'write') {
        throw new ToolError('SCOPE_NOT_WRITABLE', "scope 'all' 是只读的;写的时候请指定一个具体作用域。")
      }
      return { all: true }
    }
    if (normalized.kind === 'global') return { scope: 'global' }
    if (normalized.kind === 'current-project') return { scope: currentProjectScope() }
    if (normalized.kind === 'current-session') {
      // MCP 没有可跨 IDE 共享的会话 id:裸 `session` 落到当前工作区
      // (与上游"拿不到会话就回退 project"同语义)。
      return { scope: currentProjectScope() }
    }
    if (normalized.kind === 'project' || normalized.kind === 'session') {
      // 显式 `project:<path>` / `session:<id>` —— 原样保留。
      return { scope: normalized.scope }
    }
    // 自定义名:先看它是不是某个作用域的别名,不是就当自定义作用域本身。
    if (names && typeof names.scopeOf === 'function') {
      const mapped = names.scopeOf(normalized.scope)
      if (typeof mapped === 'string' && mapped.length > 0) return { scope: mapped }
    }
    return { scope: normalized.scope }
  }

  /** 读路径要覆盖的作用域键列表。 */
  function readScopeKeys(raw) {
    const resolved = resolveScope(raw, 'read')
    if (resolved.all) return store.allScopeKeys()
    if (raw === undefined || raw === null || String(raw).trim() === '') return defaultReadScopes()
    return [resolved.scope]
  }

  /**
   * 把 supersedes 的 8 位前缀解析成**完整 UUID**再落盘。
   *
   * 上游 0.25.12 起按完整 id 精确查退役记录,写短前缀会让被取代的旧记录
   * "永远算不上退役"(检索照旧返回两条)。目标必须与本条同作用域 —— 上游同语义。
   *
   * @param {string} token 完整 id 或 8 位前缀
   * @param {string} scopeKey 本条记录将写入的作用域
   * @returns {string} 目标记录的完整 id
   */
  function resolveSupersedesToken(token, scopeKey) {
    const inScope = store.listRecords({ scopeKeys: [scopeKey] })
    if (inScope.some((r) => r.id === token)) return token
    const hits = [...new Set(inScope
      .filter((r) => typeof r.id === 'string' && r.id.startsWith(token))
      .map((r) => r.id))]
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) {
      throw new ToolError('SUPERSEDES_AMBIGUOUS',
        `supersedes 前缀 ${token} 在作用域 ${scopeKey} 里命中 ${hits.length} 条记录,请写更长的前缀或完整 id。`)
    }
    const elsewhere = store.listRecords({}).some((r) => typeof r.id === 'string' && r.id.startsWith(token))
    throw new ToolError('SUPERSEDES_UNKNOWN',
      `supersedes 目标 ${token} 不在作用域 ${scopeKey} 里`
      + (elsewhere ? '(它属于其他作用域;被取代记录必须与本条同作用域)' : ';请先用 memory_search 确认 id。'))
  }

  // ── memory_save ────────────────────────────────────────────────
  async function memorySave(args = {}) {
    const content = requireString(args.content, 'CONTENT_EMPTY', 'content').trim()
    const kind = args.kind === undefined || args.kind === null ? 'note' : args.kind
    if (!KINDS.includes(kind)) {
      throw new ToolError('KIND_INVALID', `kind 无效:${JSON.stringify(kind)}。可用值:${KINDS.join(' / ')}`)
    }
    const importance = optionalNumber(args.importance, { field: 'importance', min: 0, max: 1, code: 'IMPORTANCE_RANGE' })
    const tags = Array.isArray(args.tags) ? args.tags.map((t) => String(t)) : []
    const supersedesToken = typeof args.supersedes === 'string' && args.supersedes.trim() !== ''
      ? args.supersedes.trim()
      : undefined

    let scopeKey
    let alias
    const pathArg = typeof args.path === 'string' ? args.path.trim() : ''
    const scopeArg = typeof args.scope === 'string' ? args.scope.trim() : ''

    if (pathArg !== '') {
      // path 给出 = 项目作用域;此时 scope 是它的显示名(别名),不再当作用域选择器。
      if (scopeArg !== '' && scopeArg.toLowerCase() !== 'project') {
        const lower = scopeArg.toLowerCase()
        if (lower === 'global' || lower === 'session' || lower === 'all') {
          throw new ToolError('PATH_SCOPE_CONFLICT', `path 只能配合项目作用域使用,不能再指定 scope="${scopeArg}"`)
        }
        alias = scopeArg
      }
      const abs = normalizeProjectPath(pathArg, config.projectBasePath ?? process.cwd())
      scopeKey = projectScopeKey(abs)
    } else if (scopeArg === '') {
      // 省略 scope → 默认 global(跨 IDE 共享);DSH_MEMORY_SCOPE_ALL=true 时改成 project。
      scopeKey = config.defaultSaveScope === 'project' ? currentProjectScope() : 'global'
    } else {
      const resolved = resolveScope(scopeArg, 'write')
      scopeKey = resolved.scope
    }

    const supersedes = supersedesToken !== undefined
      ? resolveSupersedesToken(supersedesToken, scopeKey)
      : undefined

    if (alias !== undefined && names && typeof names.claim === 'function') {
      try {
        names.claim(scopeKey, alias)
      } catch (error) {
        throw new ToolError(error?.code ?? 'SCOPE_NAME_INVALID', error?.message ?? '作用域别名登记失败')
      }
    }

    const { deduped, record } = store.save({
      scope: scopeKey,
      content,
      kind,
      tags,
      source: { origin: 'explicit' },
      ...(importance !== undefined ? { importance } : {}),
      ...(supersedes !== undefined ? { supersedes } : {}),
      // kind=state 默认 7 天 TTL(与上游默认一致);到期后检索/列表默认不返回,记录仍保留。
      ...(kind === 'state' ? { expiredAt: Date.now() + STATE_TTL_MS } : {}),
    })

    // 向量回填(失败不影响保存本身)
    if (vector && vector.enabled && !deduped) {
      try {
        const vecs = await vector.embed([content], { timeoutMs: vector.cfg?.writeTimeoutMs })
        if (vecs && vecs[0]) {
          store.appendSidecar(scopeKey, record.id, normalizeInPlace(vecs[0]))
        }
      } catch {
        // 嵌入不可用 → 纯词法检索
      }
    }

    const text = deduped
      ? `已更新(内容重复,幂等)记忆 ${shortId(record.id)} @ ${scopeKey}`
      : `已保存记忆 ${shortId(record.id)} @ ${scopeKey}`
    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        ok: true,
        id: record.id,
        shortId: shortId(record.id),
        scope: record.scope ?? scopeKey,
        kind: record.kind ?? kind,
        deduped,
        alias: alias ?? null,
        message: text,
      },
    }
  }

  // ── memory_search ──────────────────────────────────────────────
  async function memorySearch(args = {}) {
    const query = requireString(args.query, 'QUERY_EMPTY', 'query').trim()
    const topK = optionalNumber(args.topK, { field: 'topK', min: TOPK_MIN, max: TOPK_MAX, code: 'TOPK_RANGE' })
      ?? TOPK_DEFAULT
    const includeSuperseded = args.includeSuperseded === true

    const scopeKeys = readScopeKeys(args.scope)
    const now = Date.now()
    const queryTokens = [...new Set(tokenize(query))]

    // 读一遍就够:词法通道、向量通道、superseded 集合共用同一份快照。
    // (store 层每次 listRecords 都会现读盘,重复读会白白多几次 IO。)
    const byScope = new Map()
    for (const scopeKey of scopeKeys) {
      byScope.set(scopeKey, store.listRecords({ scopeKeys: [scopeKey] }))
    }

    // 被其他记录 supersedes 指向的 id = 已退役;默认不参与召回(与上游 0.26 同口径)。
    const supersededIds = new Set()
    for (const records of byScope.values()) {
      for (const rec of records) if (rec.supersedes) supersededIds.add(rec.supersedes)
    }

    // 通道 1:词法召回(IDF 在每个 scope 内部独立统计)
    const candidates = new Map()
    const recordById = new Map()
    for (const [scopeKey, records] of byScope) {
      if (records.length === 0) continue
      const tokenSets = records.map((r) => new Set(tokenize(r.content ?? '')))
      const stats = buildStats(tokenSets)
      const isGlobal = scopeKey === 'global'
      for (let i = 0; i < records.length; i++) {
        const rec = records[i]
        recordById.set(rec.id, rec)
        if (rec.expiredAt && rec.expiredAt < now) continue
        if (!includeSuperseded && supersededIds.has(rec.id)) continue
        const lex = lexicalScore(queryTokens, tokenSets[i], stats)
        if (lex <= 0) continue
        // 强命中(共享拉丁词或 CJK bigram)用宽松阈值;只有单字命中要过更高的地板。
        const floor = isGlobal ? GLOBAL_THRESHOLD : PROJECT_THRESHOLD
        const effective = hasStrongHit(queryTokens, tokenSets[i]) ? floor : Math.max(floor, REAL_HIT_FLOOR)
        if (lex < effective) continue
        candidates.set(rec.id, { record: rec, recallScore: lex, isGlobal })
      }
    }

    // 通道 2:向量召回(hybrid = max(lexical, cosine),**不是**加权求和)
    if (vector && vector.enabled) {
      try {
        const qvecs = await vector.embed([query], { timeoutMs: vector.cfg?.timeoutMs })
        const qvec = qvecs && qvecs[0]
        if (qvec) {
          for (const scopeKey of scopeKeys) {
            const sidecar = store.readSidecar(scopeKey)
            if (!sidecar || sidecar.vectors.size === 0) continue
            // 模型身份不匹配 ⇒ 整个边车作废(上游语义),绝不用旧模型的向量算相似度。
            // 空串 identity = 还没有头(新文件),那是"尚未嵌入",不是"不匹配"。
            // 用 store.identityMatches():上游 0.10.0 起写三段头(含 pooling),严格比会静默丢弃。
            if (!store.identityMatches(sidecar.identity)) continue
            for (const [id, vec] of sidecar.vectors) {
              if (!vec) continue
              const sim = cosine(qvec, vec)
              if (sim < VECTOR_MIN_SCORE) continue
              const existing = candidates.get(id)
              if (existing) {
                existing.recallScore = Math.max(existing.recallScore, sim)
                continue
              }
              const rec = recordById.get(id)
              if (!rec) continue
              if (rec.expiredAt && rec.expiredAt < now) continue
              if (!includeSuperseded && supersededIds.has(rec.id)) continue
              if (rec.scope === 'global' && sim < GLOBAL_THRESHOLD) continue
              candidates.set(id, { record: rec, recallScore: sim, isGlobal: rec.scope === 'global' })
            }
          }
        }
      } catch {
        // 向量通道失败 → 保留词法结果
      }
    }

    // 打分:词法/余弦召回分 × 时间衰减 × 重要度 × 触达加成 × 被取代惩罚
    const shape = (c) => recordScore(
      c.recallScore,
      c.record.importance ?? 0.5,
      c.record.accessCount ?? 0,
      c.record.lastAccessedAt ?? c.record.updatedAt ?? now,
      { now, halfLifeDays: HALF_LIFE_DAYS, superseded: supersededIds.has(c.record.id) },
    )

    const ranked = [...candidates.values()]
      .sort((a, b) => shape(b) - shape(a)
        || scopeTier(a.record.scope ?? 'global') - scopeTier(b.record.scope ?? 'global')
        || String(a.record.id).localeCompare(String(b.record.id)))
      .slice(0, RECALL_N)
      .slice(0, topK)

    // 触达计数:用 touchMany(按 scope 分组,每个 scope 只锁一次 / 只重写一次)。
    // 只对最终返回的 topK 做,不对全部候选做 —— 后者会把磁盘写放大 N 倍。
    store.touchMany(ranked.map((c) => c.record.id))

    const lines = ranked.map((c) => {
      const score = round4(shape(c))
      const rec = c.record
      const head = `[${score.toFixed(4)}] (${rec.scope ?? 'global'}/${rec.kind ?? 'note'}) ${summarize(rec.content)}`
      const meta = [
        `id=${shortId(rec.id)}`,
        rec.tags && rec.tags.length > 0 ? `tags=${rec.tags.join(',')}` : null,
        `importance=${Number(rec.importance ?? 0).toFixed(2)}`,
        rec.updatedAt ? `updated=${new Date(rec.updatedAt).toISOString().slice(0, 19).replace('T', ' ')}` : null,
      ].filter(Boolean).join('  ')
      return `${head}\n    ${meta}`
    })

    const scopeText = scopeKeys.length === 0 ? '(无)' : scopeKeys.map(scopeLabel).join(', ')
    const text = ranked.length === 0
      ? `没有找到匹配「${query}」的记忆(检索范围:${scopeText})。`
      : `找到 ${ranked.length} 条记忆(检索范围:${scopeText})\n\n${lines.join('\n\n')}`
        + '\n\n提示:需要完整内容时用 memory_get 传入上面的 8 位 id 前缀。'

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        ok: true,
        query,
        count: ranked.length,
        scopes: scopeKeys,
        // 字段名用 `records` 而非 `results`：上游 DSH 的 memory_search 返回 {records:[...]}
        // (lib/tools/index.js:296-305),同名能让同一个 agent 在两边用同一套读取习惯。
        // 摘要只在 `content[0].text`(必读通道)出现一次 —— 结构化通道只放机器可判字段,
        // 否则同一条记忆的正文会在一次调用里出现两三遍(见 SUMMARY_CHARS 注释)。
        records: ranked.map((c) => ({
          id: c.record.id,
          shortId: shortId(c.record.id),
          score: round4(shape(c)),
          scope: c.record.scope ?? 'global',
          kind: c.record.kind ?? 'note',
          contentLength: (c.record.content ?? '').length,
          tags: c.record.tags ?? [],
          importance: c.record.importance ?? 0,
          updatedAt: c.record.updatedAt ?? null,
        })),
      },
    }
  }

  // ── memory_list ────────────────────────────────────────────────
  async function memoryList(args = {}) {
    const limit = optionalNumber(args.limit, { field: 'limit', min: LIMIT_MIN, max: LIMIT_MAX, code: 'LIMIT_RANGE' })
      ?? LIMIT_DEFAULT
    const kind = typeof args.kind === 'string' && args.kind.trim() !== '' ? args.kind.trim() : undefined
    if (kind !== undefined && !KINDS.includes(kind)) {
      throw new ToolError('KIND_INVALID', `kind 无效:${JSON.stringify(kind)}。可用值:${KINDS.join(' / ')}`)
    }

    const scopeKeys = readScopeKeys(args.scope)
    // 先取全量再过滤:退役/过期记录被隐藏后仍要凑够 limit 条(与上游同口径)。
    const allRecords = store.listRecords({
      scopeKeys,
      ...(kind !== undefined ? { kind } : {}),
    })
    const now = Date.now()
    const supersededIds = new Set()
    for (const rec of allRecords) if (rec.supersedes) supersededIds.add(rec.supersedes)
    const records = allRecords
      .filter((rec) => !(rec.expiredAt && rec.expiredAt < now) && !supersededIds.has(rec.id))
      .slice(0, limit)

    const lines = records.map((rec) => {
      const updated = rec.updatedAt ? new Date(rec.updatedAt).toISOString().slice(0, 19).replace('T', ' ') : '-'
      return `[${shortId(rec.id)}] (${rec.scope ?? 'global'}/${rec.kind ?? 'note'}) ${summarize(rec.content)}\n`
        + `    importance=${Number(rec.importance ?? 0).toFixed(2)}  updated=${updated}`
        + `${rec.tags && rec.tags.length > 0 ? `  tags=${rec.tags.join(',')}` : ''}`
    })
    const scopeText = scopeKeys.length === 0 ? '(无)' : scopeKeys.map(scopeLabel).join(', ')
    const text = records.length === 0
      ? `没有记忆(范围:${scopeText})。`
      : `列出 ${records.length} 条记忆(范围:${scopeText})\n\n${lines.join('\n\n')}`
        + '\n\n提示:需要完整内容时用 memory_get 传入上面的 8 位 id 前缀。'

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        ok: true,
        count: records.length,
        scopes: scopeKeys,
        // 与 memory_search 同口径:摘要只在 content[0].text 出现一次,正文走 memory_get。
        records: records.map((rec) => ({
          id: rec.id,
          shortId: shortId(rec.id),
          scope: rec.scope ?? 'global',
          kind: rec.kind ?? 'note',
          contentLength: (rec.content ?? '').length,
          tags: rec.tags ?? [],
          importance: rec.importance ?? 0,
          updatedAt: rec.updatedAt ?? null,
        })),
      },
    }
  }

  // ── memory_get ─────────────────────────────────────────────────
  async function memoryGet(args = {}) {
    const rawIds = Array.isArray(args.ids) ? args.ids : []
    const ids = [...new Set(rawIds.map((v) => String(v).trim()).filter((v) => v !== ''))].slice(0, GET_MAX_IDS)
    if (ids.length === 0) {
      throw new ToolError('IDS_EMPTY', 'ids 必须是非空字符串数组(可写 8 位 id 前缀)')
    }

    // id 是全局 UUID,所以跨所有作用域找。
    // (listRecords 省略 scopeKeys = 所有作用域,比先 allScopeKeys() 再逐个读盘更省。)
    const allRecords = store.listRecords({})
    const found = []
    const seen = new Set()
    const missing = []
    for (const token of ids) {
      const exact = allRecords.find((r) => r.id === token)
      const hit = exact ?? allRecords.find((r) => typeof r.id === 'string' && r.id.startsWith(token))
      if (!hit) {
        missing.push(token)
        continue
      }
      // 同一个 id 可能被「8 位前缀」和「完整 id」各命中一次 —— 只取一次。
      if (seen.has(hit.id)) continue
      seen.add(hit.id)
      found.push(hit)
    }

    const lines = found.map((rec) => {
      const updated = rec.updatedAt ? new Date(rec.updatedAt).toISOString().slice(0, 19).replace('T', ' ') : '-'
      return `[${shortId(rec.id)}] (${rec.scope ?? 'global'}/${rec.kind ?? 'note'}) ${rec.content ?? ''}\n`
        + `    importance=${Number(rec.importance ?? 0).toFixed(2)}  updated=${updated}`
        + `${rec.tags && rec.tags.length > 0 ? `  tags=${rec.tags.join(',')}` : ''}`
        + `${rec.supersedes ? `  supersedes=${shortId(rec.supersedes)}` : ''}`
    })
    const parts = []
    if (found.length > 0) parts.push(`取回 ${found.length} 条记忆:\n\n${lines.join('\n\n')}`)
    if (missing.length > 0) parts.push(`未找到 ${missing.length} 个 id:${missing.join(', ')}`)
    const text = parts.length > 0 ? parts.join('\n\n') : '没有找到任何记忆。'

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        ok: missing.length === 0,
        count: found.length,
        records: found.map((rec) => ({
          id: rec.id,
          shortId: shortId(rec.id),
          scope: rec.scope ?? 'global',
          kind: rec.kind ?? 'note',
          content: rec.content ?? '',
          tags: rec.tags ?? [],
          importance: rec.importance ?? 0,
          updatedAt: rec.updatedAt ?? null,
          supersedes: rec.supersedes ?? null,
        })),
        missing,
      },
    }
  }

  // ── memory_forget ──────────────────────────────────────────────
  async function memoryForget(args = {}) {
    const id = typeof args.id === 'string' ? args.id.trim() : ''
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (!id && !query) {
      throw new ToolError('TARGET_REQUIRED', '请提供 id 或 query 其中之一(两个都不给无法确定删什么)')
    }
    if (id && query) {
      throw new ToolError('TARGET_AMBIGUOUS', 'id 与 query 只能二选一:给 id 就是精确删,给 query 就是按内容子串批量删')
    }

    if (id) {
      // 精确 id 跨作用域唯一,scope 参数不适用(也不需要解析)。
      const allRecords = store.listRecords({})
      const exact = allRecords.find((r) => r.id === id)
      const hit = exact ?? allRecords.find((r) => typeof r.id === 'string' && r.id.startsWith(id))
      if (!hit) {
        const text = `没有找到 id 为 ${id} 的记忆,未删除任何内容。`
        return {
          content: [{ type: 'text', text }],
          structuredContent: { ok: true, deleted: 0, ids: [], message: text },
        }
      }
      const result = store.deleteById(hit.id)
      const deleted = result.deleted === true
      const text = deleted
        ? `已删除 1 条记忆 ${shortId(hit.id)} @ ${hit.scope ?? 'global'}`
        : `删除失败:没能删除记忆 ${shortId(hit.id)}`
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          ok: deleted,
          deleted: deleted ? 1 : 0,
          ids: deleted ? [hit.id] : [],
          message: text,
        },
      }
    }

    // query 路径:解析作用域。省略 → 当前工作区(不会误删 global)。
    let scopeKey
    if (args.scope !== undefined && args.scope !== null && String(args.scope).trim() !== '') {
      const resolved = resolveScope(args.scope, 'read')
      if (resolved.all) {
        throw new ToolError('SCOPE_NOT_WRITABLE', "scope 'all' 不能与 query 同用(防批量误删);请指定你真正想删的那个作用域")
      }
      scopeKey = resolved.scope
    } else {
      scopeKey = currentProjectScope()
    }

    const result = store.deleteByQuery(scopeKey, query)
    const deleted = result.deleted ?? 0
    const text = deleted === 0
      ? `在作用域 ${scopeLabel(scopeKey)} 里没有匹配「${query}」的记忆,未删除任何内容。`
      : `已删除 ${deleted} 条记忆(作用域 ${scopeLabel(scopeKey)},匹配「${query}」)`
        + `${result.ids && result.ids.length > 0 ? `:${result.ids.map(shortId).join(',')}` : ''}`

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        ok: true,
        deleted,
        ids: result.ids ?? [],
        scope: scopeKey,
        message: text,
      },
    }
  }

  // ── memory_index ────────────────────────────────────────────────
  async function memoryIndex(args = {}) {
    const projectRaw = typeof args.project === 'string' && args.project.trim() !== ''
      ? args.project.trim()
      : (config.projectBasePath ?? process.cwd())
    const projectDir = normalizeProjectPath(projectRaw, config.projectBasePath ?? process.cwd())
    const sources = normalizeIndexSources(args.sources)
    const since = normalizeSince(args.since)
    const files = Array.isArray(args.files) ? args.files.map((file) => String(file)) : undefined
    const maxChars = optionalNumber(args.maxChars, {
      field: 'maxChars', min: 0, max: Number.MAX_SAFE_INTEGER, code: 'MAX_CHARS_RANGE',
    }) ?? 0
    const dryRun = args.dryRun === undefined ? true : args.dryRun === true
    const confirm = args.confirm === true
    const scopeKey = projectScopeKey(projectDir)
    const memoryDir = resolve(projectDir, '.workbuddy', 'memory')
    const existing = store.listRecords({ scopeKeys: [scopeKey] })
    const built = buildIndexPlan({
      projectDir, memoryDir, sources, files, since, maxChars, records: existing,
    })
    const counts = { new: 0, supersede: 0, skip: 0 }
    for (const item of built.plan) counts[item.action]++

    const lines = built.plan.map((item) => {
      const label = item.action === 'new' ? '新增' : item.action === 'supersede' ? '替换' : '跳过'
      return `[${label}] ${item.relativePath}#${item.heading} (${item.content.length} chars)`
    })
    const head = `索引计划 @ ${scopeKey}\n`
      + `来源: ${sources.join(', ')}；文件: ${built.files.length}；章节: ${built.plan.length}\n`
      + `计划: ${counts.new} new / ${counts.supersede} supersede / ${counts.skip} skip`
    const text = `${head}\n\n${lines.join('\n')}`
      + (built.skippedFiles.length > 0
        ? `\n\n跳过文件:\n${built.skippedFiles.map((file) => `- ${file.path}: ${file.reason}`).join('\n')}`
        : '')

    if (dryRun || !confirm) {
      const reason = dryRun ? 'dryRun=true，未写入' : 'confirm=false，未写入'
      return {
        content: [{ type: 'text', text: `${text}\n\n${reason}` }],
        structuredContent: {
          ok: true,
          scope: scopeKey,
          dryRun,
          confirmed: confirm,
          counts,
          files: built.files.length,
          sections: built.plan.length,
          skippedFiles: built.skippedFiles,
          plan: built.plan.map((item) => ({
            path: item.relativePath,
            heading: item.heading,
            action: item.action,
            hash: item.hash,
            contentLength: item.content.length,
          })),
        },
      }
    }

    const applied = await applyIndexPlan({
      store: store.raw,
      scope: scopeKey,
      plan: built.plan,
      vector,
      noVector: !vector?.enabled,
    })
    return {
      content: [{
        type: 'text',
        text: `${text}\n\n写入完成: ${applied.counts.new} new / ${applied.counts.supersede} supersede / ${applied.counts.skip} skip`
          + `\nvector: ${applied.vectors.appended} appended / ${applied.vectors.failed} failed`,
      }],
      structuredContent: {
        ok: applied.vectors.failed === 0,
        scope: scopeKey,
        dryRun: false,
        confirmed: true,
        counts: applied.counts,
        files: built.files.length,
        sections: built.plan.length,
        vectors: applied.vectors,
      },
    }
  }

  // ── memory_index_status ─────────────────────────────────────────
  async function memoryIndexStatus(args = {}) {
    const projectRaw = typeof args.project === 'string' && args.project.trim() !== ''
      ? args.project.trim()
      : (config.projectBasePath ?? process.cwd())
    const projectDir = normalizeProjectPath(projectRaw, config.projectBasePath ?? process.cwd())
    const sources = normalizeIndexSources(args.sources, ['daily'])
    const since = normalizeSince(args.since) ?? (args.sources === undefined ? defaultStatusSince() : undefined)
    const scopeKey = projectScopeKey(projectDir)
    const memoryDir = resolve(projectDir, '.workbuddy', 'memory')
    const records = store.listRecords({ scopeKeys: [scopeKey] })
    const status = inspectIndex({ projectDir, memoryDir, sources, since, records })
    const text = `索引状态 @ ${scopeKey}\n`
      + `来源: ${sources.join(', ')}；文件: ${status.files.length}；章节: ${status.plan.length}\n`
      + `新鲜度: ${status.stale} 个待更新（${status.counts.new} new / ${status.counts.supersede} supersede / ${status.counts.skip} skip）\n`
      + `现有派生记录: ${status.activeIndexed}；孤儿: ${status.orphans.length}；源缺失: ${status.missingSources.length}；最近源日期: ${status.latestSourceDate ?? '-'}`
    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        ok: true,
        scope: scopeKey,
        stale: status.stale,
        counts: status.counts,
        files: status.files.length,
        sections: status.plan.length,
        activeIndexed: status.activeIndexed,
        orphans: status.orphans.map((record) => ({
          id: record.id, path: record.source?.path, heading: record.source?.heading,
        })),
        missingSources: status.missingSources.map((record) => ({
          id: record.id, path: record.source?.path, heading: record.source?.heading,
        })),
        latestSourceDate: status.latestSourceDate,
        staleItems: status.plan
          .filter((item) => item.action !== 'skip')
          .map((item) => ({
            path: item.relativePath, heading: item.heading, action: item.action, hash: item.hash,
          })),
      },
    }
  }

  return {
    memory_save: memorySave,
    memory_search: memorySearch,
    memory_list: memoryList,
    memory_get: memoryGet,
    memory_forget: memoryForget,
    memory_index: memoryIndex,
    memory_index_status: memoryIndexStatus,
  }
}

/** 工具执行器 → MCP tools/call 结果(含结构化输出)。失败时返回错误文本而不是抛栈。 */
export async function runTool(handlers, name, args) {
  const handler = handlers[name]
  if (!handler) {
    const text = `未知工具:${name}。可用工具:${TOOL_NAMES.join(', ')}`
    return { content: [{ type: 'text', text }], structuredContent: { ok: false, code: 'UNKNOWN_TOOL', message: text } }
  }
  try {
    const result = await handler(args ?? {})
    return result
  } catch (error) {
    const code = error?.code ?? 'TOOL_ERROR'
    const message = error instanceof Error ? error.message : String(error)
    const text = `错误(${code}):${message}`
    return {
      content: [{ type: 'text', text }],
      structuredContent: { ok: false, code, message: text },
      isError: true,
    }
  }
}

/** 生成 MCP `tools/list` 的载荷。 */
export function toolDescriptors() {
  return TOOL_NAMES.map((name) => ({
    name,
    title: name,
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: TOOL_SCHEMAS[name],
    outputSchema: OUTPUT_SCHEMA,
  }))
}
