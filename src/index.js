#!/usr/bin/env node
/**
 * bin 入口 —— 解析启动参数与环境变量,装配 store / 向量后端 / 工具,拉起 MCP 服务。
 *
 * 启动参数(都支持 `--key value` 与 `--key=value` 两种写法):
 *   --project, --project-dir <dir>   当前工作区目录(绝对或相对)。决定 `project` / `project:<路径>` 作用域。
 *   --store-dir, --store <dir>       记忆存储目录(与 DSH 插件共用同一个)。
 *   -h, --help                       打印用法后退出(0)。**不启动服务、不碰 store、不加载 SDK**。
 *   -v, --version                    打印版本后退出(0)。
 *
 * 环境变量:
 *   DSH_MEMORY_PROJECT      等价于 --project
 *   DSH_MEMORY_STORE_DIR    等价于 --store-dir
 *   DSH_MEMORY_SCOPE_ALL    1/true/yes/on ⇒ memory_save 省略 scope 时默认写 project 而不是 global
 *   DSH_MEMORY_VECTOR       off ⇒ 关闭向量检索(纯词法)
 *   DSH_MEMORY_EMBED_*      见 src/vector.js
 *   DSH_MEMORY_DEBUG        1 ⇒ 启动失败时额外打印完整调用栈(默认只打一行原始错误)
 *
 * ⚠️ stdout 属于 MCP 协议;运行期日志都走 stderr。唯一的例外是 `--help` / `--version`:
 *    那时 MCP 会话还没建立,按 CLI 惯例写 stdout,`dsh-memory-mcp --help | less` 才好用。
 *
 * ⚠️ `./server.js` 必须**动态导入**。它静态依赖 @modelcontextprotocol/sdk,而 ESM 的静态
 *    import 在**链接阶段**就崩 —— `main()` 里的 try/catch 和 `main().catch(...)` 都轮不到执行,
 *    用户只会看到十行英文栈。只有动态导入才能把"未安装依赖"翻译成可操作的中文提示。
 *
 * Copyright (c) 2026 restregular
 * SPDX-License-Identifier: MIT
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SharedStore } from './store.js'
import { ScopeNames } from './scope-names.js'
import { createTools, normalizeProjectPath } from './tools.js'
import { VectorBackend } from './vector.js'

/**
 * 默认存储目录 —— **平台中立**的 `~/.dsh-memory-store`。
 *
 * ⚠️ 这里**不能**再写死某台机器的绝对路径(旧版是 `D:/dev/.dsh-memory-store`)。
 *    clone 下来直接跑的人:Windows 上没 D 盘就 ENOENT,Linux / macOS 上会建出一个
 *    名叫 `D:` 的垃圾目录。跨平台的默认值只能是「用户主目录下的一个固定子目录」。
 *
 * ⚠️ 但「默认值能用」不等于「默认值是对的」:本服务真正要共用的是 **DSH 插件的
 *    `storeDir`**。两者不一致时服务照常跑,只是看到的是另一份(空的)记忆库 ——
 *    这是本仓库最容易让人误判「没生效」的地方。所以 `main()` 在用默认值启动时
 *    会打一条显式提示,要求使用者核对与 DSH 是否同一个目录。
 */
export const DEFAULT_STORE_DIR = join(homedir(), '.dsh-memory-store')

/** 程序名(bin 名)。 */
const CLI_NAME = 'dsh-memory-mcp'

/** 仓库根目录(`src/..`),用于给出 `npm install` 的确切位置。 */
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// ────────────────────────────────────────────────────────────────────
// 参数解析
// ────────────────────────────────────────────────────────────────────

/** `--flag value` 形式:flag → 目标字段。`--project-dir` / `--store` 是既有别名,不能丢。 */
const VALUE_FLAGS = {
  '--project': 'project',
  '--project-dir': 'project',
  '--store-dir': 'storeDir',
  '--store': 'storeDir',
}

/** `--flag=value` 形式:flag(含 `=`)→ 目标字段。 */
const EQ_FLAGS = {
  '--project=': 'project',
  '--project-dir=': 'project',
  '--store-dir=': 'storeDir',
  '--store=': 'storeDir',
}

const HELP_FLAGS = new Set(['-h', '--help'])
const VERSION_FLAGS = new Set(['-v', '--version'])

/**
 * 解析 `--key value` / `--key=value` 形式的参数。
 *
 * 与旧版的区别:**不再静默忽略**不认识的参数。`--store_dir` / `--storedir` 这类笔误
 * 以前会让服务悄悄回退到默认 store(在别人机器上等于写到莫名其妙的目录),现在会被
 * 收集到 `unknown` 里,由 `main()` 以退出码 2 拒绝启动。
 *
 * @returns {{
 *   project: string|undefined, storeDir: string|undefined,
 *   help: boolean, version: boolean,
 *   unknown: string[], missing: string[],
 * }}
 *   `unknown` = 不认识的 flag / 多余的位置参数;`missing` = 需要取值但没给值的 flag。
 */
export function parseArgs(argv = []) {
  const out = { project: undefined, storeDir: undefined, help: false, version: false, unknown: [], missing: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i])
    if (HELP_FLAGS.has(arg)) { out.help = true; continue }
    if (VERSION_FLAGS.has(arg)) { out.version = true; continue }
    // 等号形式优先 —— `--store-dir=D:\x` 不能被当成未知参数。
    const eq = arg.indexOf('=')
    if (eq > 0 && arg.startsWith('--')) {
      const key = arg.slice(0, eq + 1)
      const target = EQ_FLAGS[key]
      if (target) {
        const value = arg.slice(eq + 1)
        if (value === '') out.missing.push(key.slice(0, -1))
        else out[target] = value
      } else {
        out.unknown.push(key.slice(0, -1))
      }
      continue
    }
    const target = VALUE_FLAGS[arg]
    if (target) {
      const value = argv[i + 1]
      // 值缺失,或者下一个 token 已经是另一个 flag(`--store-dir --help`)⇒ 报错,
      // 不要把 `--help` 当成目录名悄悄吃掉。
      if (value === undefined || value === '' || String(value).startsWith('--')) {
        out.missing.push(arg)
        if (value === '') i++
      } else {
        out[target] = String(value)
        i++
      }
      continue
    }
    // 其它一律算未知参数 —— 宁可直接报错,也不要静默回退到默认值。
    // 若未知 flag 后面跟了一个非 flag 的 token,当成它的取值一起跳过:
    // 这样 `--store_dir D:\x` 只报 `--store_dir`,不会把路径也当成一个"未知参数"。
    out.unknown.push(arg)
    const next = argv[i + 1]
    if (arg.startsWith('-') && next !== undefined && !String(next).startsWith('-')) i++
  }
  return out
}

function truthy(value) {
  if (typeof value !== 'string') return false
  const v = value.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/** 组装运行期配置(环境变量 + 启动参数);优先级:argv > env > 默认。 */
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

// ────────────────────────────────────────────────────────────────────
// --version / --help
// ────────────────────────────────────────────────────────────────────

/**
 * 版本号 —— 从 package.json 读,**单一来源**。
 *
 * 不从 `./server.js` 的 SERVER_VERSION 读是刻意的:那条链静态依赖 SDK,
 * 而 `--version` 必须在"依赖没装"时也能用。`selftest-cli.mjs` 会断言两者一致。
 */
export function packageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof pkg?.version === 'string' && pkg.version !== '' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * 帮助文本。
 *
 * ⚠️ 这里的每一句都必须与 `parseArgs` / `resolveConfig` / `main` 的实际行为一致 ——
 *    改行为时同步改这里,别让 `--help` 变成第二份过期文档。
 */
export function helpText() {
  return `${CLI_NAME} ${packageVersion()} —— 把 DSH 的长期记忆库暴露成独立 MCP 服务(stdio)

用法:
  ${CLI_NAME} [--project <dir>] [--store-dir <dir>]
  ${CLI_NAME} --help | --version

启动参数(都支持空格与等号两种写法,等号写法见示例):
  --project, --project-dir <dir>
      当前工作区目录。决定 project / project:<路径> 作用域;相对路径按当前工作目录解析。
      默认:环境变量 DSH_MEMORY_PROJECT,再退回 process.cwd()。
      目录不存在时只告警、不阻止启动(project 作用域仍按该路径建立)。
  --store-dir, --store <dir>
      记忆存储目录(与 DSH 插件共用同一份 JSONL + 向量边车);相对路径按当前工作目录解析。
      默认:环境变量 DSH_MEMORY_STORE_DIR,再退回 ${DEFAULT_STORE_DIR}。
  -h, --help
      打印本帮助后退出(0)。不启动服务、不探活向量、不创建 store 目录、不加载 MCP SDK。
  -v, --version
      打印版本后退出(0)。

环境变量:
  DSH_MEMORY_PROJECT           等价于 --project
  DSH_MEMORY_STORE_DIR         等价于 --store-dir
  DSH_MEMORY_SCOPE_ALL         1/true/yes/on ⇒ memory_save 省略 scope 时默认写 project(否则 global)
  DSH_MEMORY_VECTOR            off/0/false/no/disabled ⇒ 关闭向量,退化为纯词法检索
  DSH_MEMORY_EMBED_ENDPOINT    指定已有 embedding 服务(如 http://127.0.0.1:8078);设了就永不 spawn 进程
  DSH_MEMORY_EMBED_EXE         llama-server 可执行文件
  DSH_MEMORY_EMBED_MODEL       gguf 模型文件
  DSH_MEMORY_EMBED_PORT        服务端口(默认 8199;DSH 用 8078,两者可共存)
  DSH_MEMORY_EMBED_THREADS     线程数(默认 6)
  DSH_MEMORY_EMBED_POOLING     池化方式(默认按模型推断:qwen3-embedding ⇒ last / bge ⇒ cls)
  DSH_MEMORY_DEBUG             1 ⇒ 启动失败时额外打印完整调用栈

示例:
  # 与 DSH 共用默认 store,最省事
  ${CLI_NAME}

  # 指定工作区与 store(等号形式等价,在 JSON 配置里少两层引号)
  ${CLI_NAME} --project D:/dev/my-app --store-dir D:/dev/.dsh-memory-store
  node src/index.js --store-dir=D:/dev/.dsh-memory-store

  # 只要词法检索(不探活、不 spawn llama-server)
  DSH_MEMORY_VECTOR=off ${CLI_NAME}

退出码:
  0   正常退出(--help / --version;服务在 stdin 关闭后也以 0 退出)
  1   启动失败(store 目录不可建、依赖缺失等),会打印可操作的中文提示
  2   参数错误(未知参数、参数缺值),不会启动服务

⚠️ stdout 属于 MCP 协议;运行期日志全部走 stderr(只有 --help / --version 写 stdout)。
   配置示例与设计说明见 README.md。`
}

// ────────────────────────────────────────────────────────────────────
// 启动期错误诊断
// ────────────────────────────────────────────────────────────────────

/** 路径状态:目录 / 文件 / 不存在。 */
function pathKind(p) {
  try {
    return statSync(p).isDirectory() ? 'dir' : 'file'
  } catch {
    return 'missing'
  }
}

/**
 * 从目标路径往上找**第一个不存在**的祖先;目标本身存在则返回 null。
 * 用来把 `mkdir ENOENT` 翻译成"盘符不存在 / 父目录不存在"。
 */
function firstMissingAncestor(target) {
  let cur = target
  for (let guard = 0; guard < 64; guard++) {
    if (existsSync(cur)) return null
    const parent = dirname(cur)
    if (parent === cur) return cur
    cur = parent
  }
  return cur
}

/** 组装 `--store-dir` 不可用的诊断行。 */
function storeDirDiagnosis(storeDir, code, message, prefix) {
  const missing = firstMissingAncestor(storeDir)
  let reason
  if (missing === null) {
    if (pathKind(storeDir) === 'file') reason = '这个路径已存在且是个文件,不是目录'
    else if (code === 'EPERM' || code === 'EACCES') reason = '没有写入权限(或被安全软件 / 占用进程拦住)'
    else reason = `目录存在但子目录创建失败(${code || '未知错误'})`
  } else if (/^[A-Za-z]:[\\/]?$/u.test(missing)) {
    reason = `盘符 ${missing.slice(0, 2)} 不存在(这台机器上没有这个盘)`
  } else {
    reason = `父目录不存在:${missing}`
  }
  return [
    `${prefix} ❌ 启动失败:记忆存储目录不可用:${storeDir}`,
    `${prefix}    ⇒ 原因:${reason}`,
    `${prefix}    ⇒ 改 --store-dir(或环境变量 DSH_MEMORY_STORE_DIR)指向一个已存在且可写的目录;默认是 ${DEFAULT_STORE_DIR}`,
    `${prefix}    原始错误:${code ? `${code} ` : ''}${message.split('\n')[0]}`,
  ]
}

/**
 * 把启动期异常翻译成「可操作的中文诊断」。
 *
 * 默认**不打完整栈**(栈对配置错误没有任何帮助),只在 `DSH_MEMORY_DEBUG=1` 时附上。
 *
 * @param {any} error
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ lines: string[], exitCode: number }}
 */
export function describeStartupError(error, options = {}) {
  const env = options.env ?? process.env
  const debug = truthy(env.DSH_MEMORY_DEBUG)
  const code = typeof error?.code === 'string' ? error.code : ''
  const message = String(error?.message ?? error ?? '未知错误')
  const prefix = `[${CLI_NAME}]`

  const finish = (lines, exitCode) => {
    if (debug && error?.stack) lines.push(`${prefix}    调用栈(DSH_MEMORY_DEBUG=1):\n${error.stack}`)
    return { lines, exitCode }
  }

  // ① CLI 用法错误 —— 文案已在抛错处拼好。
  if (error?.cli === true) {
    return finish(Array.isArray(error.lines) ? error.lines : [`${prefix} ❌ ${message}`], error.exitCode ?? 2)
  }

  // ② 依赖缺失 —— 只有动态 import 才抓得到(静态 import 在链接阶段就崩了)。
  if (code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (?:package|module)/u.test(message)) {
    return finish([
      `${prefix} ❌ 启动失败:缺少依赖(@modelcontextprotocol/sdk 未安装),服务无法加载。`,
      `${prefix}    ⇒ 在仓库根目录运行 npm install(当前仓库位置:${PKG_ROOT})`,
      `${prefix}    ⇒ 若已安装:确认启动时的工作目录 / 复制目标里也带了 node_modules —— 依赖不随 src/ 一起复制。`,
      `${prefix}    原始错误:${code || 'ERR_MODULE_NOT_FOUND'} ${message.split('\n')[0]}`,
    ], 1)
  }

  // ③ store 目录不可用 —— 部署到别人机器上最常见的一类失败。
  if (typeof error?.storeDir === 'string' && error.storeDir !== '') {
    return finish(storeDirDiagnosis(error.storeDir, code, message, prefix), 1)
  }

  // ④ 其它:一行可读原因 + 调试开关,不默认倒栈。
  return finish([
    `${prefix} ❌ 启动失败:${message.split('\n')[0]}`,
    `${prefix}    ⇒ 先用 --help 核对参数;设 DSH_MEMORY_DEBUG=1 复跑可打印完整调用栈。`,
    `${prefix}    原始错误:${code || '(无错误码)'}`,
  ], 1)
}

/** 参数错误(退出码 2)—— 不启动服务,也不碰 store。 */
function usageError(args) {
  const prefix = `[${CLI_NAME}]`
  const lines = [`${prefix} ❌ 参数错误`]
  for (const flag of args.unknown) lines.push(`${prefix}    未知参数:${flag}`)
  for (const flag of args.missing) lines.push(`${prefix}    参数缺少取值:${flag}`)
  lines.push(`${prefix}    ⇒ 运行 --help 查看用法`)
  const error = new Error(lines.join('\n'))
  error.cli = true
  error.exitCode = 2
  error.lines = lines
  return error
}

// ────────────────────────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────────────────────────

/**
 * 主流程:装配依赖并启动服务。
 *
 * `--help` / `--version` 走"纯 CLI"分支:**在任何动态 import / mkdir 之前返回**,
 * 所以依赖没装、盘不存在时帮助照样能打出来。
 *
 * @returns {Promise<{ exitCode?: number, config?: object, store?: object, vector?: object }>}
 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv)

  // ── 1. 纯 CLI 模式(不启动服务)─────────────────────────────────
  // 必须在 import('./server.js') 之前 —— 这是"依赖没装也能查用法"的前提。
  if (args.help) {
    process.stdout.write(`${helpText()}\n`)
    return { exitCode: 0 }
  }
  if (args.version) {
    process.stdout.write(`${CLI_NAME} ${packageVersion()}\n`)
    return { exitCode: 0 }
  }
  if (args.unknown.length > 0 || args.missing.length > 0) throw usageError(args)

  const config = resolveConfig(argv, env)
  const log = (m) => console.error(`[${CLI_NAME}] ${m}`)

  log(`store-dir  = ${config.storeDir}`)
  log(`project   = ${config.projectBasePath}(project 作用域 = project:${normalizeProjectPath(config.projectBasePath, process.cwd())})`)
  log(`默认保存作用域 = ${config.defaultSaveScope}`)

  // 用**默认值**启动时,明确提示一句:能不能看到 DSH 的记忆,取决于这个目录是不是
  // 与 DSH 插件的 `storeDir` 一致。不一致时服务一切正常,只是读到的是另一份(空的)库 ——
  // 这类"静默跑在错误目录上"的问题靠日志自证,不能靠使用者猜。
  if (!args.storeDir && !env.DSH_MEMORY_STORE_DIR) {
    log(`ℹ️  未指定 --store-dir / DSH_MEMORY_STORE_DIR,使用默认目录:${DEFAULT_STORE_DIR}`)
    log('   ⇒ 请确认它与 DSH 记忆插件的 storeDir **是同一个目录**,否则两边看到的是两份互不相通的记忆。')
    log('   ⇒ DSH 里可在「设置 → 记忆」查看当前 storeDir;也可直接比对磁盘上是否有 global.jsonl。')
  }

  // `--project` 指向的目录不存在:⚠️ 告警但**不阻止启动**。
  // 全局 mcp.json 里通常写死一个项目路径,换机器/目录还没建时直接拒绝启动会让整个
  // MCP 服务消失;而 `project:<路径>` 作用域只是一个键,等目录出现后仍命中同一作用域。
  const projectKind = pathKind(config.projectBasePath)
  if (projectKind !== 'dir') {
    log(`⚠️  --project 指向的目录${projectKind === 'file' ? '是个文件' : '不存在'}:${config.projectBasePath}`)
    log('   ⇒ 仍按该路径建立 project 作用域;若这不是你要的工作区,改 --project 或环境变量 DSH_MEMORY_PROJECT。')
  }

  // ── 2. 唯一的动态 import:SDK 依赖 ──────────────────────────────
  // 静态 import 会在链接阶段抛 ERR_MODULE_NOT_FOUND,那时本文件的任何 catch 都还没执行。
  const { startServer } = await import('./server.js')

  // 向量后端的**静态**配置先算出来(不探活、不 spawn),因为 store 需要它来校验 .vec 边车的头。
  const vector = new VectorBackend({ root: config.storeDir }, env)

  // ⚠️ 向量身份必须在第一次 readSidecar 之前设好,否则 store 无法校验 .vec 边车的头
  // (上游 issue #1 的顺序坑:先 load 再设 identity,换模型后的旧向量会被静默接受)。
  // 用**构造函数参数**而不是后置的 setVecIdentity —— 这样"顺序"不再靠代码约定维护,
  // 而是在类型上就不可能出错(中间插一行 readSidecar 也无害)。
  let store
  try {
    store = new SharedStore(config.storeDir, { vecIdentity: vector.cfg.modelName + '\t' + vector.cfg.dims })
  } catch (error) {
    // 打上目标目录,顶层 catch 才能给出"改哪个参数"的诊断(而不是裸栈)。
    if (error !== null && typeof error === 'object') error.storeDir = config.storeDir
    throw error
  }
  // ⚠️ ScopeNames 必须传 { root } —— 不传会退化成无锁持久化(并发 claim 会互相覆盖别名)。
  const names = new ScopeNames(join(config.storeDir, 'scopes.json'), { root: config.storeDir })

  if (vector.enabled) {
    // 探活 → 复用已有服务;没有才 spawn。**不阻塞**启动。
    // 失败/退化的日志由 vector.js 自己打(spawn 抛错、error 事件、external 探活失败都各有一条),
    // 这里不再重复播报,免得同样的信息出现两遍。
    vector.ensureReady().then(async (state) => {
      if (state === 'spawned') {
        log('向量后端已拉起,等待模型加载…')
        const ok = await vector.waitUntilReady(120_000)
        log(ok ? '向量后端就绪' : '向量后端启动超时,退化为纯词法检索')
      }
    }).catch((error) => {
      log(`⚠️ 向量后端不可用,退化为纯词法检索:${error?.message ?? error}`)
    })
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
  main().then(
    (result) => {
      // --help / --version:用 exitCode 自然退出,**不用 process.exit** ——
      // 后者可能截断还在管道里的 stdout(Windows 管道尤其明显)。
      if (typeof result?.exitCode === 'number') process.exitCode = result.exitCode
    },
    (error) => {
      const { lines, exitCode } = describeStartupError(error, { env: process.env })
      for (const line of lines) console.error(line)
      process.exitCode = exitCode
      // 兜底:万一还有残留句柄(比如半连接上的 transport),2 秒后强制退出,别挂住 IDE。
      const timer = setTimeout(() => process.exit(exitCode), 2000)
      timer.unref()
    },
  )
}
