/**
 * 跨进程独占锁(单 scope 粒度)。
 *
 * 为什么要自己写:DSH 插件与本 MCP 服务是**两个 Node 进程**共用同一个 storeDir。
 * Node 的内存锁对另一个进程完全无效,所以必须落到文件系统上。
 *
 * 机制:`openSync(path, 'wx')` → O_CREAT|O_EXCL|O_WRONLY,是 POSIX 保证原子的
 * "仅当不存在时才创建"。内核在这里帮了我们一次:创建成功即独占,失败即 EEXIST,
 * 整个 get-or-create 没有 TOCTOU 窗口(不像"先 existsSync 再 write"的写法)。
 *
 * 三个必须处理的现实问题:
 *
 * 1. **陈旧锁**。进程被 kill -9 时锁文件留在盘上,没有 finally 替你清理。
 *    锁内容写 `{pid, hostname, acquiredAt}`。判定陈旧用两条**或**关系的规则
 *    (任一成立即可):
 *      a) hostname 相同且该 pid 已不存在 → 持锁进程死了;
 *      b) acquiredAt 超过 30 秒 → 超时逃生阀。
 *    (b) 是自愈的:即使 pid 被系统回收后**复用**给了别的进程(导致 (a) 误判为"活着"),
 *    (b) 仍然会在 30 秒后放行,不会永久死锁。
 *
 * 2. **创建者写到一半就崩溃** → 锁文件存在但内容是空的,读出来无法判 pid。
 *    这时不能当成陈旧(持锁进程可能正活着在写),退回用**文件 mtime 判龄**。
 *
 * 3. **接管本身的竞态**。若两个进程同时判定同一个锁陈旧、都去删,就会出现
 *    "B 删掉 A 刚建的锁、C 又删一次" → 两个持有者。
 *    解法:接管动作额外先抢一把 `.steal` 互斥闸,**只有一个人能进入接管临界区**;
 *    进去之后重新读一次锁内容(判龄已在闸外做过一次),确认仍是刚才那把陈旧锁才删。
 *    第二个进程在闸外等,进闸后看到的是对方刚建的新鲜锁 → 不再接管,回去正常等待。
 *
 * 为什么同步(sync)实现:整个存储层的 API 都是同步的(readFileSync/renameSync),
 * 锁必须与事务同栈,否则"取锁 → 异步IO → 写回"之间锁已经飘走了。
 * 同步等待用 `Atomics.wait`(Node 主线程允许,浏览器主线程会抛)。
 */
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'

/** 锁目录名(放在 store 根下,与数据文件同层)。 */
export const LOCK_DIR = '.locks'
/** 默认获取超时:超时**抛错而不是无限等待** —— 宁可让调用方报错,也不要死锁。 */
export const DEFAULT_LOCK_TIMEOUT_MS = 10_000
/** 默认陈旧阈值:锁超过这么久就被判定为"持锁者大概已经死了"。 */
export const DEFAULT_STALE_MS = 30_000

const HOSTNAME = hostname()

/** 本进程当前持有的锁(按绝对路径)。用于检测递归加锁 —— 那个必然死锁,要在入口就拦。 */
const heldLocks = new Set()

/** 取锁超时。携带持锁者信息,便于直接看出"卡在谁手上"。 */
export class LockTimeoutError extends Error {
  /**
   * @param {string} scopeKey
   * @param {string} file
   * @param {number} timeoutMs
   * @param {object|null} holder 读到的持锁者信息
   */
  constructor(scopeKey, file, timeoutMs, holder) {
    const who = holder
      ? ` (held by pid=${holder.pid} on ${holder.hostname}, acquired ${Math.round((Date.now() - (holder.acquiredAt ?? 0)) / 1000)}s ago)`
      : ' (holder unknown)'
    super(`lock timeout after ${timeoutMs}ms for scope ${JSON.stringify(scopeKey)} at ${file}${who}`)
    this.name = 'LockTimeoutError'
    this.code = 'LOCK_TIMEOUT'
    this.scopeKey = scopeKey
    this.file = file
    this.holder = holder
  }
}

/** 同一进程对同一把锁递归加锁。O_EXCL 会让内层永远拿不到,10 秒后超时,所以这里提前拦。 */
export class LockRecursionError extends Error {
  /** @param {string} scopeKey */
  constructor(scopeKey) {
    super(`recursive lock on scope ${JSON.stringify(scopeKey)}: the same process already holds it; ` +
      'call the unlocked internal helper instead of nesting withLock')
    this.name = 'LockRecursionError'
    this.code = 'LOCK_RECURSION'
    this.scopeKey = scopeKey
  }
}

/**
 * 锁文件名:`sha1(scopeKey).lock`。
 *
 * 用哈希而不是 scope 键本身,理由与数据文件一致 —— scope 键可能含路径分隔符、
 * 冒号、中文与 Windows 保留名,直接当文件名既可能穿越路径也可能创建失败。
 *
 * @param {string} scopeKey
 * @returns {string}
 */
export function lockFileName(scopeKey) {
  return `${createHash('sha1').update(scopeKey).digest('hex')}.lock`
}

/**
 * 某个 scope 的锁文件绝对路径:`<root>/.locks/<sha1>.lock`。
 *
 * 锁粒度是**单个 scope 文件**而不是整个 storeDir,所以不同 scope 可以真正并发 ——
 * 一条 project: 记忆的写入不会阻塞另一条 session: 记忆的写入。
 *
 * @param {string} root
 * @param {string} scopeKey
 * @returns {string}
 */
export function lockPathFor(root, scopeKey) {
  return join(root, LOCK_DIR, lockFileName(scopeKey))
}

/**
 * 同步睡眠。用 Atomics.wait 而不是 setTimeout:这里是同步上下文,拿不到事件循环。
 *
 * @param {number} ms
 */
function sleepSync(ms) {
  if (ms <= 0) return
  // 共享一个 4 字节的 SharedArrayBuffer 当信号量;值恒为 0,于是 wait 就是纯超时等待。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * pid 是否还活着。
 *
 * `process.kill(pid, 0)` 是发 0 号信号,只做存在性检查不真杀。在 Windows 上 Node 也实现了
 * 信号 0(映射到 OpenProcess),行为与 POSIX 一致。
 * **EPERM 必须当作"活着"**:它表示进程存在但当前权限不足,而不是不存在。
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/**
 * 读一把锁的内容。
 *
 * @param {string} file
 * @returns {{ info: object|null, mtimeMs: number } | null} null 表示文件已不存在
 */
function readLockSnapshot(file) {
  let mtimeMs
  let text
  try {
    // 先 stat 后 read:两次调用之间文件可能被删除,抛错就当"已不存在",调用方重试即可。
    mtimeMs = statSync(file).mtimeMs
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  try {
    const info = JSON.parse(text)
    if (info && typeof info === 'object' && Number.isInteger(info.pid)) {
      return { info, mtimeMs }
    }
  } catch {
    // 不是合法 JSON(创建者写到一半崩溃了)→ 退回按 mtime 判龄
  }
  return { info: null, mtimeMs }
}

/**
 * 判断一个已存在的锁文件是否陈旧。
 *
 * @param {string} file
 * @param {number} staleMs
 * @returns {{ stale: boolean, holder: object|null }}
 */
export function inspectLock(file, staleMs = DEFAULT_STALE_MS) {
  const snap = readLockSnapshot(file)
  if (snap === null) return { stale: false, holder: null } // 已经没人持锁了,不是"陈旧"
  const { info, mtimeMs } = snap
  if (info === null) {
    // 空文件 / 半截 JSON:持锁者可能正活着在写,只按 mtime 判龄。
    return { stale: Date.now() - mtimeMs > staleMs, holder: null }
  }
  // (a) 同机且进程已死。跨机时 process.kill(pid) 没有意义(且可能命中本机同号进程),只看 (b)。
  if (typeof info.hostname === 'string' && info.hostname === HOSTNAME && !pidAlive(info.pid)) {
    return { stale: true, holder: info }
  }
  // (b) 超时逃生阀:PID 复用等导致 (a) 失效时,靠它保证不会永久死锁。
  if (typeof info.acquiredAt === 'number' && Date.now() - info.acquiredAt > staleMs) {
    return { stale: true, holder: info }
  }
  return { stale: false, holder: info }
}

/**
 * 尝试以 O_EXCL 创建锁文件并写入自己的身份。
 *
 * ⚠️ Windows 上"文件已存在"**不一定**报 `EEXIST`:当一个已存在的锁文件正好处于
 * 删除过程中(delete 已提交、句柄尚未释放),`CreateFile` 会报 `EPERM`/`EACCES`。
 * 这条路径在本层很常见 —— 上游的 stale-lock 接管流程本来就会删锁再重建,而多个
 * 进程同时在同一把锁上竞争时就会撞见这个窗口。
 * 只认 `EEXIST` 会让这一个瞬时窗口冒泡成 `EPERM` 异常,把一次正常的锁竞争
 * 变成硬失败(实测 4 进程并发 append 时稳定复现)。所以 **`EEXIST`/`EPERM`/`EACCES`
 * 一律视为"暂时拿不到",交给上层退避重试**。
 *
 * @param {string} file
 * @param {{ pid: number, hostname: string, acquiredAt: number }} token
 * @returns {boolean} true=抢到
 */
function tryCreateLock(file, token) {
  let fd
  try {
    fd = openSync(file, 'wx') // O_CREAT|O_EXCL|O_WRONLY:内核保证"不存在才创建"
  } catch (err) {
    if (err?.code === 'EEXIST' || err?.code === 'EPERM' || err?.code === 'EACCES') return false
    throw err
  }
  try {
    writeFileSync(fd, `${JSON.stringify(token)}\n`)
  } catch (err) {
    // 写身份失败:半截锁文件会挡住所有人 30 秒,必须当场清掉再抛。
    try {
      unlinkSync(file)
    } catch { /* 已经没了就算了 */ }
    throw err
  } finally {
    closeSync(fd)
  }
  return true
}

/**
 * 抢 `.steal` 互斥闸,只用于**接管陈旧锁**这一步。
 *
 * 这一层不做 pid 探测,只按 mtime 判陈旧:持闸临界区只有几次系统调用(重读 + unlink),
 * 毫秒级,超过 staleMs 基本可以断定持闸者已经死了。
 * 不做嵌套接管 —— 否则会无限递归。
 *
 * @param {string} stealPath
 * @param {number} staleMs
 * @returns {boolean}
 */
function acquireStealGate(stealPath, staleMs) {
  const gate = { pid: process.pid, hostname: HOSTNAME, acquiredAt: Date.now() }
  if (tryCreateLock(stealPath, gate)) return true
  let mtimeMs
  try {
    mtimeMs = statSync(stealPath).mtimeMs
  } catch {
    return false // 对方刚释放,本轮放弃,交给下一轮重试
  }
  if (Date.now() - mtimeMs > staleMs) {
    try {
      unlinkSync(stealPath)
    } catch { /* 对方可能同时清掉了 */ }
  }
  return false
}

/**
 * 在 `.steal` 闸的保护下尝试删除一把陈旧锁。
 *
 * @param {string} file
 * @param {number} staleMs
 * @returns {boolean} true=已删除,调用方可以立刻重建
 */
function tryTakeOver(file, staleMs) {
  const stealPath = `${file}.steal`
  if (!acquireStealGate(stealPath, staleMs)) return false
  try {
    // 在闸内**重新判一次**:闸外判的那一次可能已经过时(对方刚好接管并建了新锁)。
    // 此刻闸内只有一个进程,所以这里读到的就是权威现状。
    if (!inspectLock(file, staleMs).stale) return false
    try {
      unlinkSync(file)
    } catch (err) {
      // ENOENT = 别人先删了;EPERM/EACCES = Windows 上文件正在删除过程中。
      // 这些都不是"接管失败",下一轮重试即可。
      if (err?.code !== 'ENOENT' && err?.code !== 'EPERM' && err?.code !== 'EACCES') return false
    }
    return true
  } finally {
    try {
      unlinkSync(stealPath)
    } catch { /* 闸已失效也不影响正确性 */ }
  }
}

/**
 * 阻塞式获取一把锁,直到抢到或超时。
 *
 * @param {string} file
 * @param {{ timeoutMs?: number, staleMs?: number }} [opts]
 * @returns {Promise<object>} 不:同步返回 token
 */
function acquireLock(file, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS
  mkdirSync(dirname(file), { recursive: true })
  const deadline = Date.now() + timeoutMs
  const token = { pid: process.pid, hostname: HOSTNAME, acquiredAt: Date.now() }
  let delay = 1
  for (;;) {
    if (tryCreateLock(file, token)) return token
    if (tryTakeOver(file, staleMs) && tryCreateLock(file, token)) return token
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new LockTimeoutError('', file, timeoutMs, inspectLock(file, staleMs).holder)
    // 抖动:两个进程若严格同步地退避,会一直同时醒来同时失败,永远错开不了。
    sleepSync(Math.min(delay, remaining) * (0.5 + Math.random()))
    delay = Math.min(delay * 2, 50)
  }
}

/**
 * 释放锁。
 *
 * **释放前必须重新读锁内容,确认 pid + acquiredAt 都还是自己** —— 否则会误删别人后来
 * 拿到的那把锁:典型场景是本进程超时抛错后又重入,而前一次调用已经把锁交接出去了。
 * acquiredAt 也参与比对,是为了区分"同一个 pid 的两次不同持锁"(pid 不会在毫秒级内复用)。
 *
 * @param {string} file
 * @param {{ pid: number, acquiredAt: number }} token
 * @returns {boolean} true=确实删掉了自己的锁
 */
function releaseLock(file, token) {
  const snap = readLockSnapshot(file)
  if (snap === null) return false
  if (snap.info === null) return false // 内容不可解析 → 不敢认领,保守地不删(30s 后会被判定陈旧)
  if (snap.info.pid !== token.pid || snap.info.acquiredAt !== token.acquiredAt) return false
  try {
    unlinkSync(file)
    return true
  } catch {
    return false
  }
}

/**
 * 在 scope 级独占锁内执行 `fn`。
 *
 * 这是**所有写事务的唯一入口**:读-改-写必须整体在这个临界区里,
 * 只要中间有任何一步逸出锁外,另一个进程就能在"读"和"写"之间插入自己的记录,
 * 本进程随后的全量写回就会把它整条覆盖掉 —— 这正是上游 `MemoryStore.flush()` 的数据丢失机制。
 *
 * 锁是**同步**的,所以 `fn` 必须是同步函数;返回值原样透出。
 *
 * @template T
 * @param {string} scopeKey 作用域键(锁粒度 = 单个 scope 文件,不是整个 storeDir)
 * @param {() => T} fn 在锁内执行的同步临界区
 * @param {{ root: string, timeoutMs?: number, staleMs?: number }} opts
 * @returns {T} fn 的返回值
 * @throws {LockTimeoutError} 超时(默认 10 秒)—— 不无限等待
 * @throws {LockRecursionError} 同进程对同一 scope 递归加锁
 *
 * @example
 * const n = withLock('project:D:/dev', () => store.readScopeCount('project:D:/dev') + 1, { root })
 */
export function withLock(scopeKey, fn, opts) {
  const root = opts?.root
  if (typeof root !== 'string' || root.length === 0) {
    throw new TypeError('withLock: opts.root is required (the store directory)')
  }
  const file = lockPathFor(root, scopeKey)
  if (heldLocks.has(file)) throw new LockRecursionError(scopeKey)
  const token = acquireLock(file, opts)
  heldLocks.add(file)
  try {
    return fn()
  } finally {
    // 无论 fn 正常返回还是抛错都必须释放:抛错不释放的话,一个用户输入错误
    // 就能把整个 scope 锁死 30 秒。
    heldLocks.delete(file)
    releaseLock(file, token)
  }
}

/**
 * 当前是否有人持有某 scope 的锁(诊断用)。
 * @param {string} root
 * @param {string} scopeKey
 * @returns {boolean}
 */
export function isLocked(root, scopeKey) {
  const snap = readLockSnapshot(lockPathFor(root, scopeKey))
  if (snap === null) return false
  const { stale } = inspectLock(lockPathFor(root, scopeKey))
  return !stale
}
