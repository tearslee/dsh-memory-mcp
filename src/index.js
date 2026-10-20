#!/usr/bin/env node
/**
 * bin 入口 —— 解析启动参数与环境变量,装配 store / 向量后端 / 工具,拉起 MCP 服务。
 *
 * 启动参数:
 *   --project <dir>     当前工作区目录(绝对或相对)。决定 `project` / `project:<路径>` 作用域。
 *   --store-dir <dir>   记忆存储目录(与 DSH 插件共用同一个)。
 *
 * 环境变量:
 *   DSH_MEMORY_PROJECT      等价于 --project
 *   DSH_MEMORY_STORE_DIR    等价于 --store-dir
 *   DSH_MEMORY_SCOPE_ALL    true ⇒ memory_save 省略 scope 时默认写 project 而不是 global
 *   DSH_MEMORY_VECTOR       off ⇒ 关闭向量检索(纯词法)
 *   DSH_MEMORY_EMBED_*      见 src/vector.js
 *
 * ⚠️ stdout 属于 MCP 协议;所有日志都走 stderr。
 *
 * Copyright (c) 2026 restregular
 * SPDX-License-Identifier: MIT
 */

import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SharedStore } from './store.js'
import { ScopeNames } from './scope-names.js'
import { createTools, normalizeProjectPath } from './tools.js'
import { VectorBackend } from './vector.js'
import { startServer } from './server.js'

/** 默认存储目录 —— 与本机 DSH 插件的 `storeDir` 配置保持一致。 */
export const DEFAULT_STORE_DIR = 'D:/dev/.dsh-memory-store'

/** 解析 `--key value` / `--key=value` 形式的参数。 */
export function parseArgs(argv = []) {
  const out = { project: undefined, storeDir: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--project' || arg === '--project-dir') {
      out.project = argv[++i]
    } else if (arg.startsWith('--project=')) {
      out.project = arg.slice('--project='.length)
    } else if (arg === '--store-dir' || arg === '--store') {
      out.storeDir = argv[++i]
    } else if (arg.startsWith('--store-dir=')) {
      out.storeDir = arg.slice('--store-dir='.length)
    }
  }
  return out
}

function truthy(value) {
  if (typeof value !== 'string') return false
  const v = value.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/** 组装运行期配置(环境变量 + 启动参数)。 */
export function resolveConfig(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv)
  const projectBasePath = args.project || env.DSH_MEMORY_PROJECT || process.cwd()
  const storeDir = args.storeDir || env.DSH_MEMORY_STORE_DIR || DEFAULT_STORE_DIR
  return {
    projectBasePath: resolve(projectBasePath),
    storeDir: resolve(storeDir),
    // DSH_MEMORY_SCOPE_ALL=true ⇒ 保存默认落到 project 而不是 global。
    defaultSaveScope: truthy(env.DSH_MEMORY_SCOPE_ALL) ? 'project' : 'global',
  }
}

/** 主流程:装配依赖并启动服务。 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  const config = resolveConfig(argv, env)
  const log = (m) => console.error(`[dsh-memory-mcp] ${m}`)

  log(`store-dir  = ${config.storeDir}`)
  log(`project   = ${config.projectBasePath}(project 作用域 = project:${normalizeProjectPath(config.projectBasePath, process.cwd())})`)
  log(`默认保存作用域 = ${config.defaultSaveScope}`)

  // 向量后端的**静态**配置先算出来(不探活、不 spawn),因为 store 需要它来校验 .vec 边车的头。
  const vector = new VectorBackend({ root: config.storeDir }, env)

  // ⚠️ 向量身份必须在第一次 readSidecar 之前设好,否则 store 无法校验 .vec 边车的头
  // (上游 issue #1 的顺序坑:先 load 再设 identity,换模型后的旧向量会被静默接受)。
  // 用**构造函数参数**而不是后置的 setVecIdentity —— 这样"顺序"不再靠代码约定维护,
  // 而是在类型上就不可能出错(中间插一行 readSidecar 也无害)。
  const store = new SharedStore(config.storeDir, { vecIdentity: vector.cfg.modelName + '\t' + vector.cfg.dims })
  // ⚠️ ScopeNames 必须传 { root } —— 不传会退化成无锁持久化(并发 claim 会互相覆盖别名)。
  const names = new ScopeNames(join(config.storeDir, 'scopes.json'), { root: config.storeDir })

  if (vector.enabled) {
    // 探活 → 复用已有服务;没有才 spawn。**不阻塞**启动。
    vector.ensureReady().then(async (state) => {
      if (state === 'spawned') {
        log('向量后端已拉起,等待模型加载…')
        const ok = await vector.waitUntilReady(120_000)
        log(ok ? '向量后端就绪' : '向量后端启动超时,退化为纯词法检索')
      }
    }).catch(() => {})
  } else {
    log('向量检索已关闭(DSH_MEMORY_VECTOR=off),使用纯词法检索')
  }

  const handlers = createTools({
    store,
    names,
    config: { ...config, vector },
  })

  const { close, transport } = await startServer(handlers)

  let closing = false
  const shutdown = async (signal) => {
    if (closing) return
    closing = true
    log(`收到 ${signal},正在退出…`)
    try {
      await close()
    } catch {
      // 忽略
    }
    // 只杀自己 spawn 的 llama-server;复用的外部服务原样留着。
    try {
      vector.stop()
    } catch {
      // 忽略
    }
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
  process.on('exit', () => {
    try {
      vector.stop()
    } catch {
      // 忽略
    }
  })
  // 客户端断开(stdio 关闭)也要退出 —— 否则进程会一直挂着,
  // 连带把它 spawn 的 llama-server 留在后台(而且还占着日志文件的句柄)。
  transport.onclose = () => { void shutdown('transport closed') }

  return { config, store, vector, handlers, shutdown }
}

// 直接运行时启动;被 import 时不启动。
const invokedDirectly = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[dsh-memory-mcp] 启动失败:${error?.stack ?? error}`)
    process.exit(1)
  })
}
