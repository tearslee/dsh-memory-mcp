/**
 * 作用域别名(重命名)。
 *
 * 语义**逐字复制**自 @restregular/dsh-memory@0.7.2 的 `lib/provider/scope-names.js`
 * (MIT License, Copyright (c) 2026 restregular),许可证全文见 third-party-notices.md。
 *
 * 保留语义:
 *   - 项目作用域的身份始终是 `project:<绝对路径>`,别名只影响显示与引用;
 *   - 同一路径复用同名是幂等的;**不同路径抢同一个名字**直接拒绝(SCOPE_NAME_TAKEN);
 *   - 别名文件是 `<root>/scopes.json`,与记忆数据同目录。
 *
 * 本层的**跨进程加固**:上游 `persist()` 是裸 `writeFileSync` + 常驻内存 `this.map`。
 * 两个进程各改一次别名,后写的会把先写的整份映射覆盖掉(和上游 MemoryStore 一样的病),
 * 而且别名丢失是**静默**的(渲染出错误的显示名,不报错)。
 * 这里改为:每次 load/claim/release 都**重新读盘**,并在 `.locks/scopes.json` 这把
 * 全局锁下做「读-改-写」,再原子写回。别名文件与 scope 数据文件不同粒度,所以用固定键。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { normalizeScopeName } from './scope.js'
import { withLock } from './lock.js'

/** 别名文件的固定锁键 —— `scopes.json` 是全局单文件,不按 scope 切分。 */
const ALIAS_LOCK_KEY = '@@scopes.json'

/**
 * 作用域别名表。构造时只记下文件路径,**不缓存内容**(跨进程安全的核心)。
 */
export class ScopeNames {
  /** @type {string} */
  file
  /** @type {string} store 根目录(用于派生锁路径) */
  root
  /** @type {{ timeoutMs?: number, staleMs?: number }} */
  lockOpts

  /**
   * @param {string} file `<root>/scopes.json` 的绝对路径
   * @param {{ root?: string, lockTimeoutMs?: number, lockStaleMs?: number }} [opts]
   *   传 `root` 才能启用加锁持久化;不传则退化为无锁(仍每次重读,不缓存)。
   */
  constructor(file, opts = {}) {
    this.file = file
    this.root = opts.root ?? dirname(file)
    this.lockOpts = { root: this.root, timeoutMs: opts.lockTimeoutMs, staleMs: opts.lockStaleMs }
  }

  /**
   * 从磁盘读整张映射。坏文件返回 `{}`(不抛错)——
   * 别名是装饰性元数据,它坏了不该让整个存储层不可用。
   * @returns {Record<string, { name: string, updatedAt: number }>}
   */
  load() {
    try {
      if (!existsSync(this.file)) return {}
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
      const out = {}
      for (const [scope, value] of Object.entries(raw)) {
        const name = value?.name
        if (typeof name === 'string' && name.length > 0) {
          out[scope] = { name, updatedAt: Number(value?.updatedAt) || 0 }
        }
      }
      return out
    } catch {
      return {}
    }
  }

  /**
   * 该 scope 的别名(没有则 undefined)。
   * @param {string} scope
   * @returns {string | undefined}
   */
  nameOf(scope) {
    return this.load()[scope]?.name
  }

  /**
   * 该 scope 的**展示名**:有别名用别名,否则回退到 scope 键本身。
   * 面板/工具渲染时直接用这个,省掉调用点的 `?? scope`。
   * @param {string} scope
   * @returns {string}
   */
  labelOf(scope) {
    return this.load()[scope]?.name ?? scope
  }

  /**
   * 名字 → scope 键(读路径可以把名字当 scope 用)。
   * @param {string} name
   * @returns {string | undefined}
   */
  scopeOf(name) {
    const wanted = normalizeScopeName(name)
    if (!wanted.ok) return undefined
    for (const [scope, entry] of Object.entries(this.load())) {
      if (entry.name === wanted.name) return scope
    }
    return undefined
  }

  /**
   * 给 scope 登记别名。同名同 scope → 幂等;不同 scope 同名 → SCOPE_NAME_TAKEN。
   * 名字规则复用自定义作用域名(小写折叠、1~64 码点、禁止路径分隔符等)。
   *
   * 「读-改-写」在锁内完成:两个进程同时 claim 时,第二个看到的是第一个写完的映射,
   * 于是能正确地判成同名冲突而不是互相覆盖。
   *
   * @param {string} scope
   * @param {string} rawName
   * @param {number} [now]
   * @returns {string} 规范化后的名字
   * @throws {Error & { code?: string }} SCOPE_NAME_INVALID / SCOPE_NAME_TAKEN
   */
  claim(scope, rawName, now = Date.now()) {
    const normalized = normalizeScopeName(rawName)
    if (!normalized.ok) throw nameError('SCOPE_NAME_INVALID', normalized.message)
    const name = normalized.name
    const apply = () => {
      const map = this.load()
      const holder = this.scopeOfInMap(map, name)
      if (holder !== undefined && holder !== scope) {
        throw nameError('SCOPE_NAME_TAKEN', `作用域名「${name}」已被 ${holder} 使用;换一个名字,或直接用路径作用域`)
      }
      if (map[scope]?.name === name) return name
      map[scope] = { name, updatedAt: now }
      this.persist(map)
      return name
    }
    return withLock(ALIAS_LOCK_KEY, apply, this.lockOpts)
  }

  /** scopeOf 的内部版本:在已加载的映射上查,避免在锁内重复读盘。 */
  scopeOfInMap(map, name) {
    for (const [scope, entry] of Object.entries(map)) {
      if (entry.name === name) return scope
    }
    return undefined
  }

  /**
   * 删除某个 scope 的别名。
   * @param {string} scope
   * @returns {boolean} 是否确实删掉了
   */
  release(scope) {
    return withLock(ALIAS_LOCK_KEY, () => {
      const map = this.load()
      if (!(scope in map)) return false
      delete map[scope]
      this.persist(map)
      return true
    }, this.lockOpts)
  }

  /**
   * 原子写回整张映射(tmp + rename,含 pid 防撞名)。**只在锁内调用。**
   * @param {Record<string, { name: string, updatedAt: number }>} map
   */
  persist(map) {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    let fd
    try {
      fd = openSync(tmp, 'wx')
      writeFileSync(fd, `${JSON.stringify(map, null, 2)}\n`, 'utf8')
    } catch (err) {
      try { unlinkSync(tmp) } catch { /* 没建成就算了 */ }
      throw err
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    try {
      renameSync(tmp, this.file)
    } catch (err) {
      try { unlinkSync(tmp) } catch { /* 已改名则无 tmp */ }
      throw err
    }
  }
}

function nameError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * 便捷构造:`new SharedScopeNames(root)` → 指向 `<root>/scopes.json`。
 * @param {string} root
 * @param {{ lockTimeoutMs?: number, lockStaleMs?: number }} [opts]
 * @returns {ScopeNames}
 */
export function createScopeNames(root, opts = {}) {
  return new ScopeNames(join(root, 'scopes.json'), { root, ...opts })
}
