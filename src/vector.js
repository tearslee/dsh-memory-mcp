/**
 * 向量后端封装 —— 本地 llama-server(OpenAI 兼容 `/v1/embeddings`)。
 *
 * 与 DSH 插件的关系:
 *   - DSH 的 provider 跑在 8078 端口,本 MCP 默认跑 8199,**两者可共存**;
 *   - 探活到已有服务就**复用**(不接管生命周期、不杀进程),没有才自己 spawn;
 *   - 退出时**只杀自己 spawn 的那个**,绝不误杀 DSH 或别人起的实例。
 *
 * 熔断:连续失败后指数退避(1s → 2s → 4s … 上限 30s),避免每次检索都白等一次超时。
 * 超时分级:交互检索 300ms 预算;写入/回填 10s 预算(整段内容在 CPU 上嵌入慢得多)。
 *
 * 全部功能可用 `DSH_MEMORY_VECTOR=off` 关闭,退化为纯词法检索。
 *
 * 行为(探活/熔断/超时分级/端点协议)对齐 @restregular/dsh-memory 0.7.2 的
 * `lib/provider/embed.js` 与 `lib/provider/embed-server.js`,按 MIT 许可复用。
 *
 * Copyright (c) 2026 restregular
 * SPDX-License-Identifier: MIT
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { openSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 默认端口:避开 DSH 的 8078,两者可同时跑。 */
export const DEFAULT_PORT = 8199
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_THREADS = 6
export const DEFAULT_MODEL = 'Qwen3-Embedding-0.6B-Q8_0.gguf'
/** 传给 `/v1/embeddings` 的 model 名(llama-server 认这个字符串)。 */
export const DEFAULT_MODEL_NAME = 'qwen3-embedding-0.6b'
/** 向量维度(与 store 里 `.vec` 边的 `#qwen3-embedding-0.6b\t1024` 一致)。 */
export const DEFAULT_DIMS = 1024
/** 交互检索的嵌入预算(ms)。 */
export const DEFAULT_TIMEOUT_MS = 300
/** 写入 / 回填的嵌入预算(ms)。 */
export const DEFAULT_WRITE_TIMEOUT_MS = 10_000
/** 熔断退避上限(ms)。 */
export const MAX_BACKOFF_MS = 30_000

/**
 * 池化方式 —— **必须跟着模型走**,否则算出来的向量与 DSH 已有的向量不在同一个空间里。
 *
 * 上游 `models.js` 的注释写得很清楚:
 *   "BGE 系用 cls, Qwen3-Embedding 用 last"
 * 实测(2026-10-20,本机 D:/dev/.dsh-memory-store/global.vec):
 *   拿 DSH 存好的向量与现算的向量比余弦 ——
 *     pooling=last → cos = 1.0000(完全一致)
 *     pooling=cls  → cos = 0.3522(完全不同的空间)
 * 所以这里默认 `last`;换 BGE 系模型时自动切回 `cls`。
 */
export const DEFAULT_POOLING = 'last'

const DEFAULTS = {
  exe: 'D:\\dev\\llamacpp\\llama-server.exe',
  model: 'D:\\dev\\models\\Qwen3-Embedding-0.6B-Q8_0.gguf',
}

/** 归一化模型文件路径 → API 的 model 名。`Qwen3-Embedding-0.6B-Q8_0.gguf` → `qwen3-embedding-0.6b`。 */
export function modelNameOf(modelPath) {
  const base = String(modelPath ?? '').split(/[\\/]/).pop() ?? ''
  const stem = base.replace(/\.gguf$/i, '')
  // 去掉量化后缀(`-Q8_0`),保留模型本名
  const cleaned = stem.replace(/-[A-Za-z]+\d+(?:_\d+)?$/i, '')
  return cleaned.toLowerCase() || DEFAULT_MODEL_NAME
}

/**
 * 按模型名推断池化方式。
 *   - BGE 系列 → `cls`
 *   - 其它(Qwen3-Embedding / nomic 等)→ `last`
 */
export function poolingOf(modelName) {
  const name = String(modelName ?? '').toLowerCase()
  if (name.includes('bge')) return 'cls'
  if (name.includes('nomic')) return 'mean'
  return DEFAULT_POOLING
}

function envFlag(value) {
  if (typeof value !== 'string') return false
  const v = value.trim().toLowerCase()
  return v === 'off' || v === '0' || v === 'false' || v === 'no' || v === 'disabled'
}

function envInt(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback
  const n = Number.parseInt(String(value), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * 从环境变量 + 显式 opts 组装出后端配置。
 *
 * 环境变量:
 *   DSH_MEMORY_VECTOR=off        关闭向量(纯词法)
 *   DSH_MEMORY_EMBED_ENDPOINT     直接指定已有服务(此时**永不** spawn)
 *   DSH_MEMORY_EMBED_EXE          llama-server 可执行文件
 *   DSH_MEMORY_EMBED_MODEL        gguf 模型文件
 *   DSH_MEMORY_EMBED_PORT         端口(默认 8199)
 *   DSH_MEMORY_EMBED_THREADS      线程数(默认 6)
 *   DSH_MEMORY_EMBED_POOLING      池化方式(默认按模型推断:Qwen3-Embedding=last / BGE=cls)
 */
export function resolveVectorConfig(opts = {}, env = process.env) {
  const enabled = !envFlag(env.DSH_MEMORY_VECTOR) && opts.enabled !== false
  const endpointRaw = typeof env.DSH_MEMORY_EMBED_ENDPOINT === 'string' && env.DSH_MEMORY_EMBED_ENDPOINT.trim() !== ''
    ? env.DSH_MEMORY_EMBED_ENDPOINT.trim()
    : (typeof opts.endpoint === 'string' && opts.endpoint.trim() !== '' ? opts.endpoint.trim() : '')
  const port = envInt(env.DSH_MEMORY_EMBED_PORT, opts.port ?? DEFAULT_PORT)
  const host = opts.host ?? DEFAULT_HOST
  const baseUrl = endpointRaw !== ''
    ? endpointRaw.replace(/\/v1\/embeddings\/?$/i, '').replace(/\/+$/, '')
    : `http://${host}:${port}`
  const modelPath = env.DSH_MEMORY_EMBED_MODEL?.trim() || opts.model || DEFAULTS.model
  const modelName = opts.modelName || modelNameOf(modelPath)
  const pooling = opts.pooling ?? env.DSH_MEMORY_EMBED_POOLING?.trim() ?? poolingOf(modelName)
  return {
    enabled,
    endpoint: `${baseUrl}/v1/embeddings`,
    baseUrl,
    healthUrl: `${baseUrl}/health`,
    /** 显式指定了外部端点 ⇒ 永不 spawn。 */
    external: endpointRaw !== '',
    exe: env.DSH_MEMORY_EMBED_EXE?.trim() || opts.exe || DEFAULTS.exe,
    model: modelPath,
    modelName,
    dims: opts.dims ?? DEFAULT_DIMS,
    pooling,
    port,
    host,
    threads: envInt(env.DSH_MEMORY_EMBED_THREADS, opts.threads ?? DEFAULT_THREADS),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    writeTimeoutMs: opts.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS,
    logFile: opts.logFile ?? (opts.root ? join(opts.root, 'llama-server-mcp.log') : null),
    root: opts.root ?? null,
  }
}

/**
 * 向量后端。
 *
 * 生命周期:
 *   ensureReady()  探活 → 活着就复用;不活才 spawn(只 spawn 一个)。
 *   embed(texts)   嵌入文本,失败返回 null(调用方退化为纯词法)。
 *   stop()         只杀自己 spawn 的进程。
 */
export class VectorBackend {
  constructor(opts = {}, env = process.env) {
    this.cfg = resolveVectorConfig(opts, env)
    this.child = null
    this.pid = null
    /** true = 这个进程是我们 spawn 的,退出时才可以杀。 */
    this.owned = false
    this.healthy = false
    this.lastFailureAt = 0
    this.backoffMs = 1000
    this.consecutiveFailures = 0
    this.readyPromise = null
    this.spawned = false
    this.log = opts.log ?? ((m) => { console.error(`[dsh-memory-mcp] ${m}`) })
    this.deps = {
      spawn: opts.spawn ?? nodeSpawn,
      probe: opts.probe,
      fetchImpl: opts.fetchImpl ?? globalThis.fetch,
    }
  }

  get enabled() {
    return this.cfg.enabled
  }

  get isHealthy() {
    return this.healthy
  }

  /** 向量身份:`model\tdims`,与 `.vec` 边车文件头一致。 */
  get identity() {
    return `${this.cfg.modelName}\t${this.cfg.dims}`
  }

  /** 熔断是否打开(失败后不立刻重试)。 */
  get tripped() {
    if (this.consecutiveFailures === 0) return false
    return Date.now() - this.lastFailureAt < this.backoffMs
  }

  async probe(timeoutMs = 1500) {
    if (this.deps.probe) return Boolean(await this.deps.probe(this.cfg.healthUrl, timeoutMs))
    try {
      const res = await this.deps.fetchImpl(this.cfg.healthUrl, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) return false
      const json = await res.json().catch(() => null)
      return json?.status === 'ok' || json?.status === undefined
    } catch {
      return false
    }
  }

  /**
   * 确保后端可用。返回 `'external' | 'reused' | 'spawned' | 'disabled' | 'failed'`。
   * 幂等:并发调用共享同一个 readyPromise。
   */
  async ensureReady() {
    if (!this.cfg.enabled) return 'disabled'
    if (this.readyPromise) return this.readyPromise
    this.readyPromise = this.#ensureReady().finally(() => {
      // 允许后续重新探活(失败后要能恢复)
      if (!this.healthy) this.readyPromise = null
    })
    return this.readyPromise
  }

  /**
   * 冷启动保护:模型刚加载时第一次请求会超时(llama-server 要先载入权重)。
   *
   * 那种超时**不代表后端坏了**,但如果把它记成一次失败,熔断器会打开,
   * 之后 30 秒内所有检索都直接跳过向量通道 —— 一次冷启动拖垮整个向量检索。
   * 所以:自己 spawn 出来的后端,在它就绪之前发的请求**不算失败**。
   */
  #countAsFailure(reason) {
    if (this.owned && !this.healthy) {
      // 自己拉起、还没就绪 —— 不计入熔断计数。
      this.log(`vector: 后端尚未就绪(${reason}),不计入熔断`)
      return
    }
    this.#markFailure(reason)
  }

  async #ensureReady() {
    if (this.cfg.external) {
      // 显式指定端点 ⇒ 只用不启:永不 spawn,也永不杀。
      const ok = await this.probe()
      this.healthy = ok
      this.log(`vector: 使用外部端点 ${this.cfg.baseUrl}(health=${ok ? 'ok' : 'down'})`)
      if (!ok) this.log('vector: 外部端点不可达,向量后端不可用,退化为纯词法检索')
      return ok ? 'external' : 'failed'
    }
    if (await this.probe()) {
      this.healthy = true
      this.log(`vector: 复用已有服务 ${this.cfg.baseUrl}(不接管生命周期)`)
      return 'reused'
    }
    return this.#spawn()
  }

  #spawn() {
    if (this.spawned) {
      // 已经在拉起,再等一会儿
      return this.child ? 'spawned' : 'failed'
    }
    const args = [
      '-m', this.cfg.model,
      '--embeddings',
      // 池化必须跟着模型走 —— 与 DSH 已有的向量在同一个空间里。
      ...(this.cfg.pooling && this.cfg.pooling !== 'auto' ? ['--pooling', this.cfg.pooling] : []),
      '--host', this.cfg.host,
      '--port', String(this.cfg.port),
      '-t', String(this.cfg.threads),
    ]
    let out = 'ignore'
    if (this.cfg.logFile) {
      try {
        mkdirSync(dirname(this.cfg.logFile), { recursive: true })
        out = openSync(this.cfg.logFile, 'a')
      } catch {
        out = 'ignore'
      }
    }
    let child
    try {
      child = this.deps.spawn(this.cfg.exe, args, {
        cwd: this.cfg.root ?? undefined,
        windowsHide: true,
        detached: false,
        stdio: out === 'ignore' ? 'ignore' : ['ignore', out, out],
      })
    } catch (error) {
      // spawn 同步抛错(exe 路径非法等)—— 此时**还没有**任何进程,不能说"已启动"。
      this.log(`vector: spawn 失败,向量后端不可用,退化为纯词法检索: ${error?.message ?? error}`)
      this.log(`vector: ⇒ 核对 DSH_MEMORY_EMBED_EXE(默认 ${DEFAULTS.exe})是否真实存在`)
      this.#markFailure()
      return 'failed'
    }
    // ⚠️ 顺序很重要:先登记 child/pid/spawned,再挂监听,最后**才**打"已启动"。
    // 反过来写会得到 "已启动 pid=?" 后紧跟 ENOENT 的自相矛盾日志(旧版就是这样)。
    this.child = child
    this.pid = child.pid ?? null
    this.owned = true
    this.spawned = true
    // ENOENT 之类是**异步** `error` 事件,不是 throw —— 这条路径必须有自己的日志,
    // 否则 spawn 失败后只剩 120 秒空转,用户不知道发生了什么。
    child.once('error', (error) => {
      this.log(`vector: llama-server 启动失败(${this.cfg.exe}),向量后端不可用,退化为纯词法检索: ${error?.message ?? error}`)
      this.log('vector: ⇒ 核对 DSH_MEMORY_EMBED_EXE / DSH_MEMORY_EMBED_MODEL 指向真实文件')
      this.child = null
      this.owned = false
      this.healthy = false
      this.spawned = false
      this.readyPromise = null
    })
    child.once('exit', () => {
      this.log('vector: llama-server 已退出')
      this.child = null
      this.owned = false
      this.healthy = false
      this.spawned = false
      this.readyPromise = null
    })
    if (this.pid) {
      this.log(`vector: 已启动 llama-server pid=${this.pid} ${this.cfg.baseUrl}`)
    } else {
      // spawn 成功但拿不到 pid(重定向包装器),或 exe 不存在时 pid 还没分配 ——
      // 一律照实说"pid 未分配",绝不打印 `pid=?` 假装启动成功。
      this.log(`vector: 正在启动 llama-server(pid 未分配) ${this.cfg.baseUrl}`)
    }
    return 'spawned'
  }

  /**
   * 等待后端就绪(轮询 /health)。
   *
   * 三个提前退出条件,缺一个就会空转满 timeout:
   *   ① 后端不是我们拉起的、也没在拉起(`!child && !spawned`)—— 例如 spawn 已经
   *      以异步 `error` 事件失败(child 被清成 null),旧版在这里会白等满 120 秒;
   *   ② 自己拉起的子进程已经退出(exitCode 非 null);
   *   ③ 探活成功。
   *
   * @returns true 表示可用。
   */
  async waitUntilReady(timeoutMs = 60_000) {
    if (!this.cfg.enabled) return false
    if (this.cfg.external) return this.probe()
    const deadline = Date.now() + timeoutMs
    let waitLogged = false
    while (Date.now() < deadline) {
      if (await this.probe(1500)) {
        this.healthy = true
        this.consecutiveFailures = 0
        this.backoffMs = 1000
        return true
      }
      // ① 没有可等的子进程了:spawn 失败(error 事件)或已被 stop()。
      if (!this.child && !this.spawned) return false
      // ② 子进程已经退出,再等也不会变健康。
      if (this.child && this.child.exitCode !== null) return false
      // 模型加载动辄几十秒,期间日志静默会被误判成"卡死" —— 打一次进度提示。
      if (!waitLogged) {
        waitLogged = true
        this.log(`vector: 正在等待 llama-server 加载模型(最多 ${Math.round(timeoutMs / 1000)} 秒)…`)
      }
      await new Promise((r) => setTimeout(r, 400))
    }
    return false
  }

  /**
   * 嵌入文本。
   * @returns {Promise<Float32Array[]|null>} 失败返回 null(调用方退化)。
   */
  async embed(texts, { timeoutMs, signal } = {}) {
    if (!this.cfg.enabled) return null
    if (!Array.isArray(texts) || texts.length === 0) return []
    if (this.tripped) return null
    const budget = timeoutMs ?? this.cfg.timeoutMs
    const timeout = AbortSignal.timeout(budget)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const res = await this.deps.fetchImpl(this.cfg.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: texts, model: this.cfg.modelName }),
        signal: combined,
      })
      if (!res.ok) {
        this.#countAsFailure(`HTTP ${res.status}`)
        return null
      }
      const json = await res.json()
      const data = json?.data
      if (!Array.isArray(data) || data.length !== texts.length) {
        this.#countAsFailure('响应 data 长度不匹配')
        return null
      }
      const out = []
      for (const item of data) {
        const arr = item?.embedding
        if (!Array.isArray(arr) || arr.length !== this.cfg.dims) {
          this.#countAsFailure(`向量维度不匹配(期望 ${this.cfg.dims},实际 ${Array.isArray(arr) ? arr.length : '?'})`)
          return null
        }
        const v = new Float32Array(arr)
        // llama-server 返回的向量已是 L2 归一化的,这里再防御性归一化一次
        let norm = 0
        for (let i = 0; i < v.length; i++) norm += v[i] * v[i]
        const n = Math.sqrt(norm)
        if (n > 0) for (let i = 0; i < v.length; i++) v[i] = v[i] / n
        out.push(v)
      }
      this.#markSuccess()
      return out
    } catch (error) {
      this.#countAsFailure(error?.message ?? String(error))
      return null
    }
  }

  #markSuccess() {
    this.healthy = true
    this.consecutiveFailures = 0
    this.backoffMs = 1000
  }

  #markFailure(reason = '') {
    this.healthy = false
    this.consecutiveFailures += 1
    this.lastFailureAt = Date.now()
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
    this.log(`vector: 嵌入失败(${reason}),退避 ${this.backoffMs}ms`)
  }

  /**
   * 停止后端。**只杀自己 spawn 的进程** —— 复用的外部服务原样留着。
   */
  stop() {
    if (!this.owned || !this.child) return false
    const pid = this.pid
    try {
      this.child.kill()
      this.log(`vector: 已停止 llama-server pid=${pid ?? '?'}`)
    } catch {
      // 已经退出 / 不是我们的
    }
    this.child = null
    this.owned = false
    this.spawned = false
    return true
  }
}
