/**
 * 作用域(scope)规范 —— 纯函数,无 cordis / 无 fs 依赖。
 *
 * 本文件**逐字复制**自 @restregular/dsh-memory@0.7.2 的 `lib/provider/scope.js`
 * (MIT License, Copyright (c) 2026 restregular),许可证全文见 third-party-notices.md。
 * 复制的理由与 scoring.js 相同:scope 键是**寻址主键** —— `scopeFileName()` 决定文件落在哪、
 * 锁名从哪来、`.vec` 边车跟谁配对。任何一处本地分叉都会让 MCP 进程与 DSH 插件写到两个桶里,
 * 于是"共享同一份记忆"这件事静默失效,还不报错。
 *
 * 与上游唯一的结构性差异:上游从 `./store.js` 导入 `isCustomScopeKey`。本包保持同样的依赖
 * 方向(store.js 再 re-export 本文件的 scopeFileName,循环解析 Node 原生支持,且函数都是
 * 声明式 hoisted 的纯函数,ESM 求值时不会踩到 TDZ),这样两份文件的原文都不必改动。
 *
 * 保留名与键空间:
 *   global        所有项目共享(文件 global.jsonl)
 *   project:<cwd> 一个工作区(文件 projects/<sha1>.jsonl)
 *   session:<id>  一个会话(同一套 projects/<sha1>.jsonl)
 *   <自定义名>     自由命名,内部键仍是自定义名本身
 * 三者都由 `scopeFileName()` 映射到文件名,所以**自定义名里出现 ':' 一律拒绝** ——
 * 否则 `foo:bar` 会与保留前缀撞进同一个键空间,用户还能靠它伪造 `project:` 键。
 */
import { createHash } from 'node:crypto'
import { isCustomScopeKey } from './store.js'

/** 自定义名长度上限(码点)。 */
export const MAX_SCOPE_NAME_CHARS = 64
/** project: / session: 前缀值的长度上限(路径与 uuid 都可能很长)。 */
export const MAX_PREFIXED_SCOPE_CHARS = 512

/** 保留名:不能作为自定义 scope,也不允许被自定义名覆盖(一律小写比较)。 */
export const RESERVED_SCOPE_NAMES = new Set(['global', 'project', 'session', 'all'])

/** 控制字符(C0 + DEL + C1)一律拒绝:它们能进文件名映射的输入、也能把日志搅烂。 */
function hasControlChar(value) {
  for (const char of value) {
    const code = char.codePointAt(0)
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true
  }
  return false
}

/**
 * 自定义名允许的字符:Unicode 字母 / 数字(含中文)、空格、'-'、'_'、'.'。
 * 用 `\p{L}\p{N}` 而不是 ASCII 白名单,因为中文 scope 名("项目笔记")是预期用法;
 * 文件名的歧义由 `scopeFileName()` 的 SHA-1 兜底,这里只负责禁止会造成键空间混淆的字符。
 */
const CUSTOM_NAME_ALLOWED = /^[\p{L}\p{N} _.-]+$/u

/** 码点长度({ length } 会把 emoji 数成 2,K 说"按码点")。 */
function codePointLength(value) {
  return [...value].length
}

/**
 * 规范化"自定义名"。
 *   - 内部空白(含制表/换行)折叠为单个空格;
 *   - 转小写(大小写折叠,免出 `Foo` 与 `foo` 两个 scope);
 *   - 长度 1~64 码点;
 *   - 禁止 ':'、路径分隔符、控制字符、'..'、纯点/空格组成的名字、保留名。
 */
function normalizeCustomName(raw) {
  const collapsed = raw.replace(/\s+/gu, ' ').trim()
  if (collapsed.length === 0) return { ok: false, message: 'scope name is empty after normalization' }
  if (hasControlChar(collapsed)) return { ok: false, message: 'scope name must not contain control characters' }
  const name = collapsed.toLowerCase()
  if (codePointLength(name) > MAX_SCOPE_NAME_CHARS) {
    return { ok: false, message: `scope name exceeds ${MAX_SCOPE_NAME_CHARS} characters` }
  }
  if (name === '..' || name === '.') return { ok: false, message: "scope name must not be '.' or '..'" }
  if (/^[. ]+$/u.test(name)) return { ok: false, message: 'scope name must contain more than dots and spaces' }
  if (name.includes('..')) return { ok: false, message: "scope name must not contain '..'" }
  if (name.includes(':')) return { ok: false, message: "scope name must not contain ':'" }
  if (name.includes('/') || name.includes('\\')) {
    return { ok: false, message: 'scope name must not contain path separators' }
  }
  if (RESERVED_SCOPE_NAMES.has(name)) {
    // 'global'/'project'/'session' 在到达这里之前已经各自命中保留分支,所以这里实际拦的是 'all'。
    return { ok: false, message: `scope name "${name}" is reserved` }
  }
  if (!CUSTOM_NAME_ALLOWED.test(name)) {
    return { ok: false, message: 'scope name may only contain letters, digits, spaces, "-", "_" and "."' }
  }
  return { ok: true, name }
}

/**
 * 规范化 `project:` / `session:` 前缀值(旧键与宿主键,原样放行以便读写既有数据)。
 * 只做最小清洗:trim、拒绝控制字符、拒绝空、限长 —— 绝不改写内容,否则旧文件再也找不到。
 */
function normalizePrefixed(key, label) {
  const value = key.slice(`${label}:`.length).trim()
  if (value.length === 0) return { ok: false, message: `${label}: scope requires a non-empty value` }
  if (hasControlChar(value)) return { ok: false, message: `${label}: scope value must not contain control characters` }
  if (codePointLength(key) > MAX_PREFIXED_SCOPE_CHARS) {
    return { ok: false, message: `${label}: scope exceeds ${MAX_PREFIXED_SCOPE_CHARS} characters` }
  }
  return { ok: true, key: `${label}:${value}` }
}

/**
 * 作用域"显示名/别名"的校验:与自定义作用域名同一套规则(保留名也不许用)。
 * @param {string} raw
 * @returns {{ ok: true, name: string } | { ok: false, message: string }}
 */
export function normalizeScopeName(raw) {
  return normalizeCustomName(raw)
}

/**
 * 把模型 / HTTP query 传进来的原始字符串规范化。
 *
 * 关键语义:
 *   - `undefined` / 空串 → `kind: 'current-session'`(调用方按写/读口径决定落到哪里);
 *   - 'global' | 'project' | 'session' → 各自的**种类**,不在这里解析 cwd/会话(纯函数拿不到);
 *   - 'all' | '*' → 跨所有作用域(仅读路径合法,写路径由 resolveScopeRef 拒绝);
 *   - 'project:*' | 'session:*' → 原样放行(显式 pin 某个项目 / 某个会话);
 *   - 其余 → 自定义名,严格校验。
 *
 * 不合法**不再静默回退**,一律返回 SCOPE_INVALID。
 *
 * @param {unknown} raw
 * @returns {{ ok: true, kind: string, scope?: string } | { ok: false, code: string, message: string }}
 */
export function normalizeScopeInput(raw) {
  // NFC 归一化:同一个中文 scope 从不同输入法过来可能是不同码点序列,不归一化就会分裂成两个 scope。
  const value = typeof raw === 'string' ? raw.normalize('NFC').trim() : ''
  if (value.length === 0) return { ok: true, kind: 'current-session' }
  if (value === '*') return { ok: true, kind: 'all' }
  const lower = value.toLowerCase()
  if (lower === 'global') return { ok: true, kind: 'global', scope: 'global' }
  if (lower === 'project') return { ok: true, kind: 'current-project' }
  if (lower === 'session') return { ok: true, kind: 'current-session' }
  if (lower === 'all') return { ok: true, kind: 'all' }
  if (lower.startsWith('project:')) {
    const prefixed = normalizePrefixed(value, 'project')
    return prefixed.ok
      ? { ok: true, kind: 'project', scope: prefixed.key }
      : { ok: false, code: 'SCOPE_INVALID', message: prefixed.message }
  }
  if (lower.startsWith('session:')) {
    const prefixed = normalizePrefixed(value, 'session')
    return prefixed.ok
      ? { ok: true, kind: 'session', scope: prefixed.key }
      : { ok: false, code: 'SCOPE_INVALID', message: prefixed.message }
  }
  const custom = normalizeCustomName(value)
  return custom.ok
    ? { ok: true, kind: 'custom', scope: custom.name }
    : { ok: false, code: 'SCOPE_INVALID', message: custom.message }
}

/**
 * scope 的种类(用于命名空间 / 阈值 / 排序);未知形态按自定义处理。
 * @param {string} scope
 * @returns {'global'|'project'|'session'|'custom'}
 */
export function scopeKind(scope) {
  if (scope === 'global') return 'global'
  if (scope.startsWith('project:')) return 'project'
  if (scope.startsWith('session:')) return 'session'
  return 'custom'
}

/**
 * 自定义 scope 才计入 scopes.custom.max。
 * @param {string} scope
 * @returns {boolean}
 */
export function isCustomScope(scope) {
  return isCustomScopeKey(scope)
}

/**
 * 跨 scope 合并排序时的稳定 tie-break:session > project > 自定义 > global。
 * @param {string} scope
 * @returns {number} 越小越靠前
 */
export function scopeTier(scope) {
  switch (scopeKind(scope)) {
    case 'session': return 0
    case 'project': return 1
    case 'custom': return 2
    default: return 3
  }
}

/** 写路径遇到只读 scope 时的错误码('all' 不能写)。 */
export const SCOPE_NOT_WRITABLE = 'SCOPE_NOT_WRITABLE'

// ------------------------------------------------------------------ 当前会话 / 当前项目

/** asString:只有非空字符串才算数。 */
function asString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 从宿主的 agent 对象解析出"当前会话 / 当前项目"两个 key。
 *
 *   - sessionId 优先 `agent.session.header.id`,退回 `agent.session.id`;
 *   - **子代理沿用父会话的记忆**:`header.origin === 'subagent'` 且有 `parentSession` 时,
 *     sessionId 取 parentSession(子代理是同一个任务的一部分,不该另起一个记忆作用域);
 *   - cwd 优先 `header.cwd`,退回 `projectScope` 配置,最后 `process.cwd()`;
 *   - 任何字段缺失都只降级、**绝不抛错**(注入路径上抛错会打断整个 agent 循环)。
 *
 * @param {any} agent 宿主 agent 对象(DSH 会话上下文)
 * @param {{ projectScope?: string }} [opts]
 * @returns {{ session?: string, project: string }}
 */
export function resolveCurrentScopes(agent, opts = {}) {
  let header
  let sessionId
  try {
    const session = agent?.session
    header = session?.header
    sessionId = asString(header?.id) ?? asString(session?.id)
    if (sessionId !== undefined && header?.origin === 'subagent') {
      sessionId = asString(header.parentSession) ?? sessionId
    }
  } catch {
    // 宿主对象形态意外:当作拿不到会话,继续走 project 回退
    sessionId = undefined
  }
  const cwd = asString(header?.cwd)
  // 项目 key 的优先级:**会话 cwd** > 显式配置的 projectScope > process.cwd()。
  // cwd 必须排第一:`session.header.cwd` 是宿主给的"canonical primary workspace",
  // 而 DSH 服务进程的 process.cwd() 是**profile 目录**(~/.dsh/profiles/<name>),
  // 与工作区无关 —— 0.5.5 及以前把 `project:${process.cwd()}` 当成"配置"先传进来,
  // 结果所有项目的项目级记忆都挤进同一个桶,`project:` 这个作用域等于失效。
  const project = `project:${cwd ?? stripProjectPrefix(opts.projectScope) ?? process.cwd()}`
  return sessionId !== undefined ? { session: `session:${sessionId}`, project } : { project }
}

/**
 * `project:/x` → `/x`;不是字符串或空串 → undefined(交给下一级回退)。
 *
 * 显式配置按文档写成 `project:/abs/path`(见 cordis.patch.yml),所以拼接前缀前
 * 必须先脱掉已经带上的那一层,否则会得到 `project:project:/x` —— 与配置、与真实落点都对不上。
 */
function stripProjectPrefix(value) {
  const s = asString(value)
  if (s === undefined) return undefined
  return (s.startsWith('project:') ? s.slice('project:'.length) : s) || undefined
}

// ------------------------------------------------------------------ kind → 具体 key

/**
 * 写路径的默认口径:model 省略 scope 时按 `tools.defaultScope` 落到哪个 scope。
 * 'session' 拿不到会话 → project(不报错);'global' → global。
 *
 * @param {'global'|'project'|'session'} defaultScope
 * @param {{ session?: string, project: string }} refs
 * @returns {string}
 */
export function writeScopeForDefault(defaultScope, refs) {
  if (defaultScope === 'global') return 'global'
  if (defaultScope === 'project') return refs.project
  return refs.session ?? refs.project
}

/**
 * 把 normalizeScopeInput 的结果落到具体 key。
 *
 * 写路径(`mode: 'write'`):
 *   - `undefined`(字段省略)→ defaultScope 口径;'session' 拿不到会话时**回退 project**,不报错;
 *   - 'session' → 同上;'project' → 项目 key;'global' → 'global';
 *   - 'all' / '*' → 明确报错(只读);
 *   - 显式 'session:<id>' → 原样写入(允许显式 pin 某个会话)。
 * 读路径(`mode: 'read'`):
 *   - `undefined` → `scope: undefined`(表示"由调用方决定合并集合",由工具层填三路合并);
 *   - 'session' 拿不到会话 → `scope: undefined`(等价于默认合并集合,而不是报错);
 *   - 'all' → `{ all: true }`。
 *
 * @param {{ ok: boolean, kind?: string, scope?: string, code?: string, message?: string }} input normalizeScopeInput 的结果
 * @param {{ session?: string, project: string }} refs resolveCurrentScopes 的结果
 * @param {{ mode: 'read'|'write', defaultScope?: string, sessionEnabled?: boolean, allowAll?: boolean }} opts
 * @returns {{ ok: true, scope?: string, all?: boolean } | { ok: false, code: string, message: string }}
 */
export function resolveScopeRef(input, refs, opts) {
  if (!input.ok) return { ok: false, code: input.code, message: input.message }
  if (input.kind === 'all') {
    if (opts.mode === 'write') {
      return { ok: false, code: SCOPE_NOT_WRITABLE, message: "scope 'all' is read-only; name one scope to write to" }
    }
    if (opts.allowAll === false) {
      return { ok: false, code: SCOPE_NOT_WRITABLE, message: "scope 'all' is not allowed here; name one scope" }
    }
    return { ok: true, all: true }
  }
  if (input.kind === 'global') return { ok: true, scope: 'global' }
  if (input.kind === 'current-project') return { ok: true, scope: refs.project }
  if (input.kind === 'current-session') {
    // 省略 scope:写路径按会话落点(拿不到会话 / 会话被关 → 回退项目);读路径交给
    // 调用方的合并集合 —— 工具层要的是"会话 + 项目 + global",不是单个 key。
    if (opts.mode === 'write') {
      const current = opts.sessionEnabled === false ? undefined : refs.session
      return { ok: true, scope: writeScopeForDefault(opts.defaultScope, { ...refs, session: current }) }
    }
    return { ok: true }
  }
  if (input.kind === 'session') {
    // 显式 'session:<id>' 原样 pin(开关关掉时由 provider 报 SCOPE_DISABLED);裸 'session'
    // 与省略等价:写按会话(被关则回退项目)、读交给合并集合。
    if (input.scope !== undefined) return { ok: true, scope: input.scope }
    const scope = opts.sessionEnabled === false ? undefined : refs.session
    if (opts.mode === 'write') {
      return { ok: true, scope: writeScopeForDefault(opts.defaultScope, { ...refs, session: scope }) }
    }
    return { ok: true }
  }
  // project / custom:scope 已经在 normalize 阶段确定
  if (input.scope !== undefined) return { ok: true, scope: input.scope }
  return { ok: false, code: 'SCOPE_INVALID', message: 'scope could not be resolved' }
}

// ------------------------------------------------------------------ 文件名与标签

/**
 * 自定义 scope 的稳定短哈希(8 位)。仅用于**展示/调试**;真正的文件名映射仍是
 * `scopeFileName()` 的完整 SHA-1,因此这里不参与任何寻址,不存在撞名风险。
 * @param {string} scope
 * @returns {string}
 */
export function scopeShortHash(scope) {
  return createHash('sha1').update(scope).digest('hex').slice(0, 8)
}
