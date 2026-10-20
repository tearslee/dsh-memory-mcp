/**
 * 跨进程安全的共享存储层。
 *
 * # 为什么不复用上游的 MemoryStore
 *
 * 上游 `MemoryStore` 有两个致命缺陷(本机 0.7.2 源码实测):
 *
 *   1. `loadScope()`(store.js:316-349)对每个 scope **在进程内只读盘一次**(`loaded` Set,
 *      store.js:359-362),此后所有读写都基于那份内存快照。
 *   2. `flush()`(store.js:461-480)**拿内存快照全量重写整个文件**
 *      (`writeFileSync(tmp)` + `renameSync`,store.js:473-475)。
 *
 * 二者叠加就是确定性数据丢失:DSH 插件进程写入的记录**不在** MCP 进程的内存 Map 里,
 * MCP 下一次 flush 就把 DSH 刚写的记录整条覆盖抹掉。而且不报错、不留日志。
 * `.vec` 边车同理(`writeSidecar` 是全量重写,`appendVector` 才是 append)。
 *
 * # 本层的做法
 *
 * - **不常驻内存快照**。每次操作都在锁内**重新从磁盘读取**该 scope 的全部记录。
 *   代价是每次都读盘(文件只有几 KB ~ 几 MB),换来的是"磁盘上是什么,进程内看到的就是什么"。
 * - **整个"读-改-写"在同一把跨进程锁内完成**。只要中间逸出锁外,另一个进程就能在
 *   读与写之间插入,本进程随后的全量写回又会覆盖掉它 —— 这正是上面的丢失机制。
 * - 读路径不加锁:纯读取不产生覆盖风险,加锁只会平白串行化 list/search。
 *
 * # 与上游的格式兼容
 *
 * 记录 JSONL 与 `.vec` 边车的字节格式**完全不变**,以便与 DSH 插件共用同一份 storeDir:
 *   - `<root>/global.jsonl` ← scope 键 'global'
 *   - `<root>/projects/<sha1(scope)>.jsonl` ← 其他任何 scope 键
 *   - `<root>/projects/<sha1(scope)>.vec` ← 边车,首行 `#<model>\t<dims>`,其后 `<id>\t<base64>`
 *   - `<root>/.locks/<sha1(scope)>.lock` ← 本层新增的锁文件(上游忽略未知目录)
 *
 * identity 头**只含 model 与 dims,不含 pooling** —— 与上游 `setVecIdentity(model, dims)`
 * 的 `${model}\t${dims}` 逐字节一致,否则 DSH 写的头会与本层校验的头对不上、整个边车被丢弃。
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { dirname, join } from 'node:path'
import { withLock } from './lock.js'
import {
  MAX_PREFIXED_SCOPE_CHARS,
  MAX_SCOPE_NAME_CHARS,
  RESERVED_SCOPE_NAMES,
  SCOPE_NOT_WRITABLE,
  isCustomScope,
  normalizeScopeInput,
  normalizeScopeName,
  resolveCurrentScopes,
  resolveScopeRef,
  scopeKind,
  scopeShortHash,
  scopeTier,
  writeScopeForDefault,
} from './scope.js'

// scope.js 从本文件 import isCustomScopeKey,这里再转出给上层,避免调用方两处 import。
export {
  isCustomScope,
  normalizeScopeInput,
  normalizeScopeName,
  resolveCurrentScopes,
  resolveScopeRef,
  scopeKind,
  scopeTier,
  scopeShortHash,
  writeScopeForDefault,
  MAX_PREFIXED_SCOPE_CHARS,
  MAX_SCOPE_NAME_CHARS,
  RESERVED_SCOPE_NAMES,
  SCOPE_NOT_WRITABLE,
}

/**
 * scope 键 → 相对文件名。**与上游逐字节一致,不得改动**(数据兼容的硬约束):
 *   global    → global.jsonl
 *   其他任意键 → projects/<sha1(key)>.jsonl
 * 哈希文件名结构上不可能路径穿越、也没有 Windows 保留名问题;代价是不可读,
 * 所以面板用 label 字段负责展示。
 *
 * @param {string} scope
 * @returns {string} 相对 store 根的路径(平台分隔符)
 */
export function scopeFileName(scope) {
  if (scope === 'global') return 'global.jsonl'
  const hash = createHash('sha1').update(scope).digest('hex')
  return join('projects', `${hash}.jsonl`)
}

/**
 * 自定义 scope(既不是 global,也不是 project:/session: 前缀)。
 * @param {string} scope
 * @returns {boolean}
 */
export function isCustomScopeKey(scope) {
  return scope !== 'global' && !scope.startsWith('project:') && !scope.startsWith('session:')
}

/**
 * 从 scope 文件里读回第一条合法记录的 scope。
 *
 * 项目文件名是哈希,这是**不依赖"本进程创建过该 scope"就能还原 scope 键的唯一办法**。
 * （上游 `loadDiscovered()`/`customScopeCount()` 也用同一招。）
 *
 * @param {string} file 绝对路径
 * @returns {string | null} null=文件不存在 / 读不出 / 全是坏行
 */
export function firstScopeInFile(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const rec = JSON.parse(trimmed)
      if (typeof rec.scope === 'string' && rec.scope) return rec.scope
    } catch {
      // 跳过坏行继续找:文件尾部被外部进程写坏不该让整个 scope 消失
    }
  }
  return null
}

/**
 * 内容规范化:折叠空白 + trim + 小写。去重与按查询删除都建立在这个之上。
 * @param {string} content
 * @returns {string}
 */
export function normalizeContent(content) {
  return content.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * 幂等去重用的内容哈希(复用上游公式,改了会导致新旧记录去重不到一起)。
 * @param {string} scope
 * @param {string} content
 * @returns {string} sha1 hex
 */
export function contentHash(scope, content) {
  return createHash('sha1').update(`${scope}::${normalizeContent(content)}`).digest('hex')
}

/** @returns {string} 新记录 id */
export function newId() {
  return randomUUID()
}

/** 文件存在且是普通文件(目录同名时 existsSync 也为 true,这里只认文件)。 */
function fileExists(file) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

// --- base64 向量编解码(4 字节/浮点,与上游逐字节一致) ---

/**
 * @param {Float32Array} vec
 * @returns {string} base64(原始字节,不做量化)
 */
function encodeVec(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64')
}

/**
 * @param {string} text base64
 * @returns {Float32Array | null} null=解码失败
 */
function decodeVec(text) {
  try {
    const buf = Buffer.from(text, 'base64')
    if (buf.length === 0 || buf.length % 4 !== 0) return null
    // 必须**拷贝**而不是在 Buffer 上开视图:`Buffer.from(text,'base64')` 对小对象
    // 会落在 8KB 的内存池里,一个 view 会把整块池钉住不放。上千个向量就是好几 MB 白钉。
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length))
  } catch {
    return null
  }
}

/**
 * 原子写:tmp + rename。
 *
 * rename 在同一卷内是原子的,所以读方永远看到"改之前"或"改之后"的完整文件,
 * 不会看到写了一半的内容。
 *
 * tmp 文件名带 pid 与随机数:上游固定用 `${file}.tmp`,两个进程并发时会**互相覆盖同一个
 * tmp** —— 那就不是原子写而是"谁的 rename 先来谁赢",另一个进程的数据直接凭空消失。
 *
 * @param {string} file 目标绝对路径
 * @param {string} text 内容
 */
function atomicWrite(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  let fd
  try {
    fd = openSync(tmp, 'wx')
    writeFileSync(fd, text, 'utf8')
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* 没建成就算了 */ }
    throw err
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  try {
    renameSync(tmp, file)
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* 已改名则无 tmp */ }
    throw err
  }
}

/**
 * 跨进程安全的共享存储。
 *
 * 用法固定两步:**先 `setVecIdentity()`,再做任何读边车的操作。**
 * 顺序反了会让 `.vec` 头校验失效(见 `readSidecar` 的告警),那是上游 issue #1 的同一类错误。
 */
export class SharedStore {
  /** @type {string} store 根目录 */
  root
  /** @type {(msg: string) => void} */
  onWarn
  /** `model\tdims`,用于 `.vec` 头校验;空串=未声明。 */
  vecIdentity = ''
  /** @type {{ timeoutMs?: number, staleMs?: number, onWarn?: (msg: string) => void, vecIdentity?: string }} */
  options

  /**
   * @param {string} root store 根目录,如 `D:/dev/.dsh-memory-store`
   * @param {{ vecIdentity?: string, lockTimeoutMs?: number, lockStaleMs?: number, onWarn?: (msg: string) => void }} [options]
   *   `vecIdentity` 直接在构造时给出,可以彻底消除"忘了先 setVecIdentity"的时序坑。
   */
  constructor(root, options = {}) {
    if (typeof root !== 'string' || root.length === 0) throw new TypeError('SharedStore: root is required')
    this.root = root
    this.options = options
    this.onWarn = options.onWarn ?? (() => {})
    if (options.vecIdentity !== undefined) this.vecIdentity = options.vecIdentity
    mkdirSync(join(root, 'projects'), { recursive: true })
    mkdirSync(join(root, '.locks'), { recursive: true })
  }

  /**
   * 声明产生内存中向量的 model+dims。**必须在第一次 readSidecar/appendSidecar 之前调用。**
   * @param {string} model
   * @param {number} dims
   */
  setVecIdentity(model, dims) {
    this.vecIdentity = `${model}\t${dims}`
  }

  /** 锁超时配置透传(默认 10 秒,超时抛错而非死等)。 */
  get lockOpts() {
    return {
      root: this.root,
      timeoutMs: this.options.lockTimeoutMs,
      staleMs: this.options.lockStaleMs,
    }
  }

  /** @param {string} scope @returns {string} `.jsonl` 绝对路径 */
  fileFor(scope) {
    return join(this.root, scopeFileName(scope))
  }

  /** @param {string} scope @returns {string} `.vec` 绝对路径 */
  vecFileFor(scope) {
    return join(this.root, scopeFileName(scope).replace(/\.jsonl$/, '.vec'))
  }

  /**
   * 读一个 scope 的全部记录(**不加锁**,纯只读)。
   *
   * 这是本层的核心取舍:宁可每次读盘也不要缓存。返回值每次都是新的 Map,
   * 绝不要把它长期持有 —— 那正是上游丢失数据的根源。
   *
   * @param {string} scopeKey
   * @returns {Map<string, object>} id → record;文件不存在则是空 Map(读路径绝不建文件)
   */
  readScope(scopeKey) {
    const records = new Map()
    const file = this.fileFor(scopeKey)
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (err) {
      if (err?.code !== 'ENOENT') this.onWarn(`store: cannot read ${file}: ${err?.message}`)
      return records
    }
    let lineNo = 0
    for (const line of text.split('\n')) {
      lineNo++
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const rec = JSON.parse(trimmed)
        if (!rec || typeof rec.id !== 'string' || typeof rec.content !== 'string' || typeof rec.scope !== 'string') {
          throw new Error('bad shape')
        }
        if (rec.scope !== scopeKey) continue // 文件/scope 不匹配:忽略,下次写回时自然被清理
        records.set(rec.id, rec)
      } catch {
        this.onWarn(`store: skipping malformed ${file}:${lineNo}`)
      }
    }
    return records
  }

  /**
   * 幂等写入一条记录。整个「读-改-写」在 scope 锁内完成。
   *
   * 去重键是 `contentHash(scope, content)`(复用上游公式):命中已有记录时**不新增**,
   * 只刷新 `updatedAt`/`accessCount`/`importance`(取 max),返回 `{ deduped: true }`。
   *
   * @param {{ scope: string, content: string, kind: string, tags?: string[],
   *           importance?: number, source?: object, supersedes?: string, expiredAt?: number }} recordInput
   *   `scope` **必须由调用方给出** —— 它决定文件名与锁 key,本层没有宿主上下文可推断。
   * @returns {{ deduped: boolean, record: object }}
   * @throws {Error} scope 缺失或内容为空
   */
  save(recordInput) {
    const { scope } = recordInput
    if (typeof scope !== 'string' || scope.length === 0) {
      throw new Error('SharedStore.save: recordInput.scope is required')
    }
    if (typeof recordInput.content !== 'string' || recordInput.content.trim().length === 0) {
      throw new Error('SharedStore.save: recordInput.content must be a non-empty string')
    }
    return withLock(scope, () => {
      // 锁内重读:这一刻磁盘上的状态才是权威的,任何在等锁期间写入的记录都在这里。
      const records = this.readScope(scope)
      const hash = contentHash(scope, recordInput.content)
      for (const rec of records.values()) {
        if (contentHash(rec.scope, rec.content) !== hash) continue
        rec.updatedAt = Date.now()
        rec.accessCount += 1
        rec.importance = Math.max(rec.importance ?? 0, recordInput.importance ?? 0)
        if (recordInput.supersedes) rec.supersedes = recordInput.supersedes
        this.persist(scope, records)
        return { deduped: true, record: rec }
      }
      const now = Date.now()
      const record = {
        id: newId(),
        scope,
        kind: recordInput.kind,
        content: recordInput.content,
        tags: recordInput.tags ?? [],
        source: { ...(recordInput.source ?? { origin: 'explicit' }) },
        createdAt: now,
        updatedAt: now,
        lastAccessedAt: now,
        accessCount: 0,
        importance: recordInput.importance ?? 0.8,
        ...(recordInput.supersedes ? { supersedes: recordInput.supersedes } : {}),
        ...(recordInput.expiredAt ? { expiredAt: recordInput.expiredAt } : {}),
      }
      records.set(record.id, record)
      this.persist(scope, records)
      return { deduped: false, record }
    }, this.lockOpts)
  }

  /**
   * 把一个 scope 的记录写回磁盘(原子)。**只在锁内调用。**
   *
   * global 永不因"删空"而删文件:它是唯一的保留作用域,即使将来某条路径把它清空,
   * 也只写一个空文件,不能把全局作用域从盘上抹掉。
   *
   * @param {string} scope
   * @param {Map<string, object>} records
   */
  persist(scope, records) {
    const file = this.fileFor(scope)
    if (records.size === 0 && scope !== 'global' && !fileExists(file)) return
    const lines = [...records.values()].map((r) => JSON.stringify(r))
    atomicWrite(file, lines.length ? `${lines.join('\n')}\n` : '')
  }

  /**
   * 按 id 删除。id 可能属于任意 scope,所以先扫盘定位,**再只锁那个 scope**。
   *
   * @param {string} id
   * @returns {{ deleted: boolean, record?: object, scope?: string }}
   */
  deleteById(id) {
    for (const scope of this.allScopeKeys()) {
      const records = this.readScope(scope)
      if (!records.has(id)) continue
      return withLock(scope, () => {
        // 锁内重读再删:定位与删除之间可能已经有人改了这个 scope。
        const fresh = this.readScope(scope)
        const rec = fresh.get(id)
        if (!rec) return { deleted: false }
        fresh.delete(id)
        this.persist(scope, fresh)
        // 向量同步移除:删了记录却留着向量,下次 readSidecar 会把它们当孤儿跳过,
        // 但边车会一直变大。过滤式全量重写(向量量级小,可接受)。
        this.removeVectors(scope, [id])
        return { deleted: true, record: rec, scope }
      }, this.lockOpts)
    }
    return { deleted: false }
  }

  /**
   * 在一个 scope 内按规范化内容的子串匹配删除(对齐上游 `findIdsByQuery`)。
   *
   * @param {string} scopeKey
   * @param {string} query 子串;规范化后为空则不删任何东西
   * @returns {{ deleted: number, ids: string[] }}
   */
  deleteByQuery(scopeKey, query) {
    return withLock(scopeKey, () => {
      const records = this.readScope(scopeKey)
      const needle = normalizeContent(query ?? '')
      if (needle.length === 0) return { deleted: 0, ids: [] }
      const ids = []
      for (const [id, rec] of records) {
        if (normalizeContent(rec.content).includes(needle)) ids.push(id)
      }
      if (ids.length === 0) return { deleted: 0, ids }
      for (const id of ids) records.delete(id)
      this.persist(scopeKey, records)
      this.removeVectors(scopeKey, ids)
      return { deleted: ids.length, ids }
    }, this.lockOpts)
  }

  /**
   * 列出记录(**不加锁**,只读)。按 `updatedAt` 降序,并列时 `createdAt` 降序。
   *
   * @param {{ scopeKeys?: string[], kind?: string, limit?: number }} [query]
   *   省略 `scopeKeys`(或传空数组)= 所有作用域;省略 `kind` = 不过滤;
   *   省略 `limit` = 全给。
   * @returns {object[]} record 数组
   */
  listRecords(query = {}) {
    const { scopeKeys, kind, limit } = query
    const scopes = Array.isArray(scopeKeys) && scopeKeys.length > 0 ? scopeKeys : this.allScopeKeys()
    const out = []
    for (const scope of scopes) {
      for (const rec of this.readScope(scope).values()) {
        if (kind !== undefined && rec.kind !== kind) continue
        out.push(rec)
      }
    }
    out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0))
    if (typeof limit === 'number' && limit >= 0 && out.length > limit) out.length = limit
    return out
  }

  /**
   * 磁盘上所有已发现的 scope 键。
   *
   * 哈希文件名不可读,所以靠 `firstScopeInFile()` 从文件内容还原键。
   * 文件为空 / 全是坏行 / 读不出来 → 该文件跳过(不猜、不报错),宁可少列一个 scope
   * 也不能把记录写到错误的文件名下。
   *
   * @returns {string[]}
   */
  allScopeKeys() {
    const found = []
    if (fileExists(join(this.root, 'global.jsonl'))) found.push('global')
    const projDir = join(this.root, 'projects')
    if (existsSync(projDir)) {
      let entries
      try {
        entries = readdirSync(projDir)
      } catch {
        return found
      }
      for (const name of entries) {
        if (!name.endsWith('.jsonl')) continue
        const scope = firstScopeInFile(join(projDir, name))
        if (scope) found.push(scope)
      }
    }
    return found
  }

  /**
   * 读 `.vec` 边车(**不加锁**,只读)。
   *
   * 身份头语义与上游一致:声明了 `vecIdentity` 而文件头不匹配(含"无头的旧格式"),
   * 就**整个丢弃**并返回空 vectors —— 换模型后的旧向量是**错的**,不只是过期的,
   * 混用会产生看似正常实则全错的检索结果。
   *
   * 头不匹配时 `identity` 仍会回给你(那是**盘上实际写的**身份),调用方据此决定跳过。
   *
   * @param {string} scopeKey
   * @returns {{ identity: string, model: string, dims: number, vectors: Map<string, Float32Array>, discarded: boolean }}
   *   `identity` 为盘上的 `<model>\t<dims>`(无头则空串);`discarded` 表示因不匹配被整体丢弃。
   */
  readSidecar(scopeKey) {
    const file = this.vecFileFor(scopeKey)
    const identity = this.readVecHeader(file)
    const empty = { identity, model: parseModel(identity), dims: parseDims(identity), vectors: new Map(), discarded: false }
    if (!fileExists(file)) return empty
    if (!this.vecIdentity) {
      // 先读边车再声明身份 → 所有身份校验都被绕过。上游 issue #1 就是这个顺序错误,
      // 它的后果(旧向量被静默接受)不可逆 —— 这里必须让它可见。
      this.onWarn(`${scopeKey}: readSidecar() 在 setVecIdentity() 之前调用,边车的 ${identity || '(无头)'} 向量将**未经校验**被接受`)
    }
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (err) {
      this.onWarn(`vec: cannot read ${file}: ${err?.message}`)
      return empty
    }
    const records = this.readScope(scopeKey)
    const vectors = new Map()
    let sawHeader = false
    let sawData = false
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (trimmed.startsWith('#')) {
        const declared = trimmed.slice(1)
        if (this.vecIdentity && declared !== this.vecIdentity) {
          this.onWarn(`vec: identity mismatch (${declared} != ${this.vecIdentity}); discarding sidecar for re-embed`)
          return { identity, model: parseModel(identity), dims: parseDims(identity), vectors: new Map(), discarded: true }
        }
        sawHeader = true
        continue
      }
      if (!sawData) {
        sawData = true
        if (this.vecIdentity && !sawHeader) {
          // 旧格式(无身份头)的向量来源不可知 —— 不能当作本模型的向量用。
          this.onWarn(`vec: legacy sidecar without identity header; discarding for re-embed`)
          return { identity, model: parseModel(identity), dims: parseDims(identity), vectors: new Map(), discarded: true }
        }
      }
      const tab = trimmed.indexOf('\t')
      if (tab <= 0) continue
      const id = trimmed.slice(0, tab)
      if (!records.has(id)) continue // 已删除记录的残留向量
      const vec = decodeVec(trimmed.slice(tab + 1))
      if (vec) vectors.set(id, vec)
    }
    return { identity, model: parseModel(identity), dims: parseDims(identity), vectors, discarded: false }
  }

  /** 边车首行的身份(无头则空串)。 */
  readVecHeader(file) {
    try {
      const first = readFileSync(file, 'utf8').split('\n', 1)[0] ?? ''
      return first.startsWith('#') ? first.slice(1) : ''
    } catch {
      return ''
    }
  }

  /**
   * 向 `.vec` 追加一行 `<id>\t<base64>`。**只做单行 append,绝不重写整个文件。**
   *
   * append 是文件末尾追加语义,天然跨进程安全:两个进程各写各的行,不会互相覆盖。
   * （对比上游 `writeSidecar` 的全量重写 —— 那正是 `.vec` 丢向量的机制。）
   *
   * 唯一需要锁的是「检查头 + 写头」这个临界区:两个进程若都判断"无头"再各写一个头,
   * 文件里就会出现两个 `#identity` 行,之后每次读都要额外兜底。
   *
   * 身份不匹配时**拒绝写入**(返回 `appended:false`),而不是覆盖 —— 覆盖会毁掉
   * 另一个模型已经算好的向量,而它们无法凭本层重新计算。
   *
   * @param {string} scopeKey
   * @param {string} id 记录 id
   * @param {Float32Array} vec
   * @returns {{ appended: boolean, reason?: string }}
   */
  appendSidecar(scopeKey, id, vec) {
    if (!(vec instanceof Float32Array)) {
      return { appended: false, reason: 'vector must be a Float32Array' }
    }
    if (!this.vecIdentity) {
      this.onWarn(`${scopeKey}: appendSidecar() 在 setVecIdentity() 之前调用,边车将没有身份头,下次校验会被当作旧格式整体丢弃`)
    }
    const file = this.vecFileFor(scopeKey)
    return withLock(scopeKey, () => {
      mkdirSync(dirname(file), { recursive: true })
      const header = this.readVecHeader(file)
      if (header && this.vecIdentity && header !== this.vecIdentity) {
        return { appended: false, reason: `identity mismatch: sidecar has "${header}", current is "${this.vecIdentity}"` }
      }
      // 无头但**已有数据行** → 旧格式,来源不可知。不能直接补头(等于替别人的数据
      // 声明身份),也不能静默追加(文件将永远处于"无头"状态,下次被整体丢弃)。
      if (!header && this.hasVecDataLine(file)) {
        return { appended: false, reason: 'legacy sidecar without identity header; re-embed instead of appending' }
      }
      let prefix = ''
      if (!header && this.vecIdentity) prefix = `#${this.vecIdentity}\n`
      appendFileSync(file, `${prefix}${id}\t${encodeVec(vec)}\n`, 'utf8')
      return { appended: true }
    }, this.lockOpts)
  }

  /** 边车里是否已有数据行(非头、非空)。 */
  hasVecDataLine(file) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return false
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('#')) return true
    }
    return false
  }

  /**
   * 从边车里移除若干 id:**锁内全量重写并过滤**。
   *
   * 只有删除路径会用到这里(向量量级小,可接受),写入路径永远走 append。
   * 已删除记录的向量留着无害但会一直变大,删干净更省事。
   *
   * @param {string} scopeKey
   * @param {string[]} ids
   * @returns {{ removed: number }}
   */
  removeVectors(scopeKey, ids) {
    if (ids.length === 0) return { removed: 0 }
    const file = this.vecFileFor(scopeKey)
    if (!fileExists(file)) return { removed: 0 }
    const drop = new Set(ids)
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return { removed: 0 }
    }
    const kept = []
    let removed = 0
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (trimmed.startsWith('#')) {
        kept.push(trimmed)
        continue
      }
      const tab = trimmed.indexOf('\t')
      const id = tab <= 0 ? null : trimmed.slice(0, tab)
      if (id !== null && drop.has(id)) {
        removed++
        continue
      }
      kept.push(trimmed)
    }
    atomicWrite(file, kept.length ? `${kept.join('\n')}\n` : '')
    return { removed }
  }

  /**
   * 触达一条记录(`accessCount += 1` 并刷新 `lastAccessedAt`)。
   *
   * ⚠️ 这是**写操作**,代价 = 一次锁 + 读全文件 + 重写全文件。批量触达请用 `touchMany`。
   *
   * @param {string} id
   * @returns {{ touched: boolean }}
   */
  touch(id) {
    for (const scope of this.allScopeKeys()) {
      if (!this.readScope(scope).has(id)) continue
      return { touched: this.touchIn(scope, [id]) > 0 }
    }
    return { touched: false }
  }

  /**
   * 批量触达。**只读扫描定位归属,然后按 scope 分组,每个 scope 只取一次锁、只写回一次。**
   *
   * 5 条命中分散在 5 个 scope = 5 次锁;集中在同一个 scope = 1 次锁 + 1 次重写。
   * 这是 `touch()` 直接循环的 N 倍差距,检索路径上请用这个。
   *
   * @param {string[]} ids
   * @returns {{ touched: number }}
   */
  touchMany(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return { touched: 0 }
    const byScope = new Map()
    for (const scope of this.allScopeKeys()) {
      const present = this.readScope(scope)
      const hits = ids.filter((id) => present.has(id))
      if (hits.length > 0) byScope.set(scope, hits)
    }
    let touched = 0
    for (const [scope, hits] of byScope) touched += this.touchIn(scope, hits)
    return { touched }
  }

  /** 在单个 scope 的锁内触达若干 id。 */
  touchIn(scope, ids) {
    return withLock(scope, () => {
      const records = this.readScope(scope)
      const now = Date.now()
      let n = 0
      for (const id of ids) {
        const rec = records.get(id)
        if (!rec) continue
        rec.accessCount = (rec.accessCount ?? 0) + 1
        rec.lastAccessedAt = now
        n++
      }
      if (n > 0) this.persist(scope, records)
      return n
    }, this.lockOpts)
  }

  /**
   * 该 scope 里是否已有相同内容(导入去重计数用)。**只读,不建文件。**
   * @param {string} scope
   * @param {string} content
   * @returns {boolean}
   */
  hasContent(scope, content) {
    if (!fileExists(this.fileFor(scope))) return false
    const hash = contentHash(scope, content)
    for (const rec of this.readScope(scope).values()) {
      if (contentHash(rec.scope, rec.content) === hash) return true
    }
    return false
  }

  /**
   * 在一个 scope 内按内容子串查找 id(只读)。对齐上游 `findIdsByQuery`。
   * @param {string} scope
   * @param {string} query
   * @returns {string[]}
   */
  findIdsByQuery(scope, query) {
    if (!fileExists(this.fileFor(scope))) return []
    const needle = normalizeContent(query ?? '')
    if (!needle) return []
    const ids = []
    for (const rec of this.readScope(scope).values()) {
      if (normalizeContent(rec.content).includes(needle)) ids.push(rec.id)
    }
    return ids
  }

  /**
   * 清理过期记录(逐 scope 加锁)。返回被删的 id。
   * @param {number} [now]
   * @returns {string[]}
   */
  purgeExpired(now = Date.now()) {
    const removed = []
    for (const scope of this.allScopeKeys()) {
      const records = this.readScope(scope)
      const expired = [...records.values()].filter((r) => r.expiredAt !== undefined && r.expiredAt < now)
      if (expired.length === 0) continue
      const ids = withLock(scope, () => {
        const fresh = this.readScope(scope)
        const gone = [...fresh.values()]
          .filter((r) => r.expiredAt !== undefined && r.expiredAt < now)
          .map((r) => r.id)
        if (gone.length === 0) return []
        for (const id of gone) fresh.delete(id)
        this.persist(scope, fresh)
        this.removeVectors(scope, gone)
        return gone
      }, this.lockOpts)
      removed.push(...ids)
      void records
    }
    return removed
  }

  /**
   * 每个 scope 超过上限时按「新鲜度(30 天半衰期)× 重要度」淘汰(排序公式复用上游)。
   * @param {number} maxPerScope
   * @param {number} [now]
   * @returns {string[]}
   */
  enforceLimit(maxPerScope, now = Date.now()) {
    const removed = []
    for (const scope of this.allScopeKeys()) {
      const ids = withLock(scope, () => {
        const records = this.readScope(scope)
        if (records.size <= maxPerScope) return []
        const ranked = [...records.values()]
          .map((r) => ({
            id: r.id,
            rank: Math.pow(0.5, Math.max(0, now - r.updatedAt) / 86_400_000 / 30) * (0.1 + r.importance),
          }))
          .sort((a, b) => b.rank - a.rank)
        const gone = ranked.slice(maxPerScope).map((r) => r.id)
        for (const id of gone) records.delete(id)
        this.persist(scope, records)
        this.removeVectors(scope, gone)
        return gone
      }, this.lockOpts)
      removed.push(...ids)
    }
    return removed
  }

  /**
   * 删除一个 scope 的数据文件(`.jsonl` 与 `.vec`)。**必须在该 scope 的锁内调用。**
   *
   * 只在 scope 真的被删空时调用。`global` 永不适用。
   *
   * @param {string} scope
   * @returns {boolean} 是否确实删掉了文件
   */
  removeFiles(scope) {
    if (scope === 'global') return false
    let removed = false
    for (const file of [this.fileFor(scope), this.vecFileFor(scope)]) {
      try {
        rmSync(file, { force: true })
        removed = true
      } catch (err) {
        // 删不掉不影响正确性(空文件无数据);下一次调用还会再试一次
        this.onWarn(`store: cannot remove ${file}: ${err?.message}`)
      }
    }
    return removed
  }
}

/** `<model>\t<dims>` → model 部分。 */
function parseModel(identity) {
  const tab = identity.indexOf('\t')
  return tab < 0 ? identity : identity.slice(0, tab)
}

/** `<model>\t<dims>` → dims 部分(非数字则 0)。 */
function parseDims(identity) {
  const tab = identity.indexOf('\t')
  if (tab < 0) return 0
  const n = Number.parseInt(identity.slice(tab + 1), 10)
  return Number.isFinite(n) ? n : 0
}
