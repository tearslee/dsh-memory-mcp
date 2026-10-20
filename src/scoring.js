/**
 * 词法打分 —— 纯函数,无 I/O。
 *
 * 本文件**逐字复制**自 @restregular/dsh-memory@0.7.2 的 `lib/provider/scoring.js`
 * (MIT License, Copyright (c) 2026 restregular),许可证全文见 third-party-notices.md。
 *
 * 为什么原样复用而不是重写:打分口径(尤其是 CJK 二元组与 recency 半衰期)是**跨进程共享
 * 同一份 storeDir 的前提**。DSH 插件进程与本 MCP 服务必须对同一条记录算出同一个分数,
 * 否则检索排序会随"是谁写的"而漂移。算法一旦本地分叉,共享数据就失去意义。
 *
 * 这里的取舍与上游完全一致:单字 CJK 太歧义,所以强命中要求二元组;recency 用 30 天半衰期。
 */

/**
 * 分词:拉丁词 + CJK 单字与二元组。
 *
 * 中英混排要同时覆盖两类形态:`[a-z0-9][a-z0-9_+-.]+` 取拉丁/数字词,
 * `[\u3400-\u4dbf\u4e00-\u9fff]+` 取汉字串,再拆成单字与相邻二元组。
 *
 * @param {string} text
 * @returns {string[]} token 列表(可能有重复,调用方需要时自行去重)
 */
export function tokenize(text) {
  const lower = text.toLowerCase()
  const tokens = []
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9_+\-.]{1,}/g)) tokens.push(m[0])
  for (const run of lower.matchAll(/[\u3400-\u4dbf\u4e00-\u9fff]+/g)) {
    const chars = [...run[0]]
    for (const c of chars) tokens.push(c)
    for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i] + chars[i + 1])
  }
  return tokens
}

/**
 * 统计整个 token 集合的文档频率,供 IDF 加权使用。
 *
 * @param {Iterable<Set<string>>} tokenSets 每个文档的 token 集合
 * @returns {{ df: Map<string, number>, n: number }} df 为文档频次,n 为文档数
 */
export function buildStats(tokenSets) {
  const df = new Map()
  let n = 0
  for (const set of tokenSets) {
    n++
    for (const t of set) df.set(t, (df.get(t) ?? 0) + 1)
  }
  return { df, n }
}

/**
 * IDF 加权的查询词命中率,归一化到 0..1。
 *
 * @param {string[]} queryTokens
 * @param {Set<string>} recordTokens
 * @param {{ df: Map<string, number>, n: number }} stats buildStats 的产物
 * @returns {number} 0..1
 */
export function lexicalScore(queryTokens, recordTokens, stats) {
  const unique = [...new Set(queryTokens)]
  if (unique.length === 0 || stats.n === 0) return 0
  let hit = 0
  let total = 0
  for (const t of unique) {
    const idf = Math.log(1 + stats.n / (1 + (stats.df.get(t) ?? 0)))
    total += idf
    if (recordTokens.has(t)) hit += idf
  }
  return total === 0 ? 0 : hit / total
}

/**
 * 查询与记录是否共享至少一个**强** token(长度 ≥ 2,或拉丁词,或 CJK 二元组)。
 *
 * 单个 CJK 字符歧义太大:查询里的「完」不该匹配所有含「完」的记录。
 * 只由弱 token(单字 CJK)命中的记录必须过更高的分数下限(0.25,实测命中下界),
 * 而不是宽松的那个。
 *
 * @param {string[]} queryTokens
 * @param {Set<string>} recordTokens
 * @returns {boolean}
 */
export function hasStrongHit(queryTokens, recordTokens) {
  for (const t of queryTokens) {
    if (t.length >= 2 && recordTokens.has(t)) return true
  }
  return false
}

/**
 * 指数型新鲜度衰减,半衰期可配。
 *
 * @param {number} lastAccessedAt 毫秒时间戳
 * @param {number} now 毫秒时间戳
 * @param {number} halfLifeDays 半衰期(天)
 * @returns {number} 0..1
 */
export function recencyFactor(lastAccessedAt, now, halfLifeDays) {
  const ageDays = Math.max(0, now - lastAccessedAt) / 86_400_000
  return Math.pow(0.5, ageDays / Math.max(halfLifeDays, 0.001))
}

/**
 * 总分:词法分 × 新鲜度 × 重要度 × 访问boost × 取代惩罚。
 *
 * @param {number} lexical 0..1
 * @param {number} importance 0..1
 * @param {number} accessCount
 * @param {number} lastAccessedAt
 * @param {{ now: number, halfLifeDays: number, superseded?: boolean }} opts
 * @returns {number}
 */
export function recordScore(lexical, importance, accessCount, lastAccessedAt, opts) {
  const recency = recencyFactor(lastAccessedAt, opts.now, opts.halfLifeDays)
  const importanceFactor = 0.5 + 0.5 * Math.min(1, Math.max(0, importance))
  const accessBoost = 1 + 0.1 * Math.log(1 + accessCount)
  const penalty = opts.superseded ? 0.3 : 1
  return lexical * recency * importanceFactor * accessBoost * penalty
}

/**
 * 余弦相似度。单位向量等价于点积,但这里仍做防御性归一化 ——
 * 边车里的向量可能来自不同批次的归一化策略,不能假设长度已归一。
 *
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number} -1..1
 */
export function cosine(a, b) {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * 原地归一化;零向量原样返回。返回的是同一个引用,方便链式调用。
 *
 * @param {Float32Array} v
 * @returns {Float32Array}
 */
export function normalizeInPlace(v) {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  const norm = Math.sqrt(sum)
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] = v[i] / norm
  return v
}

/**
 * LRU 集合,供 rerank/embed 去重使用。
 */
export class LruSet {
  /** @type {Map<string, unknown>} */
  map = new Map()
  /** @type {number} */
  capacity

  /** @param {number} capacity */
  constructor(capacity) {
    this.capacity = capacity
  }

  /**
   * @template T
   * @param {string} key
   * @returns {T | undefined} 命中则顺带刷新为最新
   */
  get(key) {
    const v = this.map.get(key)
    if (v !== undefined) {
      this.map.delete(key)
      this.map.set(key, v)
    }
    return v
  }

  /**
   * @template T
   * @param {string} key
   * @param {T} value
   */
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }
}
