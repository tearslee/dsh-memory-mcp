#!/usr/bin/env node
/**
 * CLI / 启动路径自测 —— 覆盖 `--help` / `--version` / 参数校验 / 启动失败诊断 / 配置解析。
 *
 * 分两层:
 *   1. **真的起子进程**(`spawnSync`)—— 端到端验证退出码、stdout/stderr 内容与"没碰盘";
 *   2. **纯函数断言**(直接 import `parseArgs` / `resolveConfig`)—— 默认值、别名、优先级、真值表。
 *
 * 两种都写是刻意的:子进程能验证"用户实际看到的输出",纯函数能覆盖子进程里很难构造的组合
 * (相对路径解析、env 优先级、`DSH_MEMORY_SCOPE_ALL` 真值表)。
 *
 * ⚠️ 绝不碰真实 store:`D:/dev/.dsh-memory-store` 一个字节都不会动。
 *    所有能写盘的用例都指向 `os.tmpdir()` 下的一次性路径,并断言**跑完仍不存在**。
 * ⚠️ 绝不 spawn 真实 llama-server:向量相关的用例一律用假 exe(`C:\nope\llama-server.exe`)
 *    或 `DSH_MEMORY_VECTOR=off`,且用非默认端口。
 * ⚠️ 绝不改动真实的 `node_modules`。「缺依赖」那一节是把 `src/` + `package.json` 复制到
 *    tmpdir(祖先目录没有 node_modules)再跑,而不是把 SDK 改名 —— 改名方案在窗口期内
 *    被强杀会留下"依赖凭空消失"的破损状态,后续所有脚本一起挂。
 *
 * 用法:
 *   node scripts/selftest-cli.mjs
 *   node scripts/selftest-cli.mjs --keep     # 保留临时目录以便排查
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_STORE_DIR, parseArgs, resolveConfig } from '../src/index.js'
import { SERVER_VERSION } from '../src/server.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const ENTRY = join(ROOT, 'src', 'index.js')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const SDK_DIR = join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk')
const SDK_BAK = join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk.__selftest_bak')

/**
 * 「依赖能不能被解析到」——**不能**直接看 `ROOT/node_modules/...` 存在与否。
 *
 * 作为依赖被 `npm install` 进别的项目时,`node_modules` 是**平铺(hoist)**的:
 * 本包自己的 `node_modules/` 通常根本不存在,SDK 在上一级。所以这里用 Node 自己的
 * 解析器回答"能不能 import",这才是真问题 —— 否则从 tarball 装完跑自测会误报失败。
 */
function dependencyResolvable() {
  try {
    import.meta.resolve('@modelcontextprotocol/sdk/package.json')
    return true
  } catch {
    return false
  }
}

const keep = process.argv.includes('--keep')

const results = []
let failures = 0

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failures++
  console.log(`${ok ? '  ✅ PASS' : '  ❌ FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`)
}

function section(title) {
  console.log(`\n${'═'.repeat(78)}\n  ${title}\n${'═'.repeat(78)}`)
}

function info(message) {
  console.log(`        ${message}`)
}

/**
 * 起一个 **CLI 子进程**(不是 MCP 会话),收集退出码与输出。
 *
 * stdin 固定给空字符串 ⇒ 关掉 stdin。这对"正常启动"的用例很关键:
 * server 在 transport 关闭时会自己退出,所以子进程不会挂住。
 */
function runCli(args, env = {}, timeout = 20_000) {
  const res = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    input: '',
    timeout,
    // 显式传干净环境:去掉调用者 shell 里可能存在的 DSH_MEMORY_* 污染。
    env: { ...baseEnv(), ...env },
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', error: res.error }
}

/** 基础环境:剥掉所有 DSH_MEMORY_* 与本机 embedding 端点,保证断言可重复。 */
function baseEnv() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('DSH_MEMORY_')) delete env[key]
  }
  return env
}

/** 一条 stderr 里是否含 Node 的栈帧(`    at xxx`)。 */
function hasStackFrames(text) {
  return /^\s{4}at\s/mu.test(text)
}

/** 生成一个"保证不存在"的一次性绝对路径(不创建它)。 */
function nonexistentPath(label) {
  return join(tmpdir(), `dsh-mcp-cli-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

const tempDirs = []
function makeTempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `dsh-mcp-cli-${label}-`))
  tempDirs.push(dir)
  return dir
}

// 硬守卫:任何用例的路径里都不许出现真实 store。
// 除了平台中立的默认值,还额外护着作者本机的实际 store(`D:/dev/.dsh-memory-store`)——
// 本仓库的开发机上它在用,被测路径一旦命中就立刻中止,不留"小心地跑"的余地。
const REAL_STORES = [DEFAULT_STORE_DIR, 'D:/dev/.dsh-memory-store']
  .map((p) => p.replace(/[\\/]+$/u, '').toLowerCase().replace(/\//gu, '\\'))
function assertNotRealStore(p) {
  const norm = String(p).toLowerCase().replace(/\//gu, '\\')
  for (const real of REAL_STORES) {
    if (norm.includes(real)) {
      console.error(`\n⛔ 自测路径命中了真实 store(${real}),中止:${p}`)
      process.exit(1)
    }
  }
}

console.log('═'.repeat(70))
console.log('  CLI / 启动路径自测')
console.log('═'.repeat(70))
console.log(`入口     : ${ENTRY}`)
console.log(`node     : ${process.version}`)
console.log(`真实 store: ${DEFAULT_STORE_DIR}(**不会**被访问)`)

try {
  // ────────────────────────────────────────────────────────────
  section('1. --help:自描述能力,且不产生任何副作用')
  // ────────────────────────────────────────────────────────────
  {
    // 用一个**不存在**的 store 路径跑 --help:如果它偷偷建了目录,后面的断言会抓到。
    const ghostStore = nonexistentPath('help-store')
    const ghostProject = nonexistentPath('help-project')
    assertNotRealStore(ghostStore)
    const r = runCli(['--help', '--store-dir', ghostStore, '--project', ghostProject])

    check('--help 退出码 0', r.status === 0, `status=${r.status}${r.error ? ` error=${r.error.message}` : ''}`)
    check('--help 输出到 stdout(不是 stderr)', r.stdout.length > 0 && r.stderr.trim() === '',
      `stdout ${r.stdout.length} 字节 / stderr ${JSON.stringify(r.stderr.slice(0, 120))}`)
    check('--help 含 --store-dir 说明', r.stdout.includes('--store-dir'), '')
    check('--help 含 --project 说明', r.stdout.includes('--project'), '')
    check('--help 含 DSH_MEMORY_ 环境变量清单', r.stdout.includes('DSH_MEMORY_'), '')
    check('--help 含 DSH_MEMORY_SCOPE_ALL', r.stdout.includes('DSH_MEMORY_SCOPE_ALL'), '')
    check('--help 含退出码含义', /退出码/u.test(r.stdout) && r.stdout.includes('2'), '')
    check('--help 含示例', /示例/u.test(r.stdout), '')
    check('--help stderr 无启动日志("已启动")',
      !r.stderr.includes('[dsh-memory-mcp] 已启动') && !r.stderr.includes('已启动 dsh-memory-mcp'), '')
    check('--help 未创建 store 目录', !existsSync(ghostStore), `期望不存在:${ghostStore}`)
    check('--help 未创建 project 目录', !existsSync(ghostProject), `期望不存在:${ghostProject}`)
    check('--help 不探活向量(stderr 无 vector:)', !r.stderr.includes('vector:'), '')

    // -h 是同一分支
    const short = runCli(['-h'])
    check('-h 等价于 --help', short.status === 0 && short.stdout.includes('--store-dir'),
      `status=${short.status}`)
    rmSync(ghostStore, { recursive: true, force: true })
    rmSync(ghostProject, { recursive: true, force: true })
  }

  // ────────────────────────────────────────────────────────────
  section('2. --version:版本号与 package.json 单一来源')
  // ────────────────────────────────────────────────────────────
  {
    const r = runCli(['--version'])
    check('--version 退出码 0', r.status === 0, `status=${r.status}`)
    check('--version 输出到 stdout', r.stdout.trim() !== '' && r.stderr.trim() === '',
      JSON.stringify(r.stdout.trim()))
    check('--version 含版本号', /\d+\.\d+\.\d+/u.test(r.stdout), r.stdout.trim())
    check('--version 版本 = package.json version', r.stdout.includes(PKG.version),
      `输出=${JSON.stringify(r.stdout.trim())} package.json=${PKG.version}`)
    check('--version 版本 = server.js 的 SERVER_VERSION(单一来源)', PKG.version === SERVER_VERSION,
      `package.json=${PKG.version} SERVER_VERSION=${SERVER_VERSION}`)
    check('--version 格式为 "<name> <version>"',
      new RegExp(`^dsh-memory-mcp ${PKG.version.replace(/\./gu, '\\.')}$`, 'u').test(r.stdout.trim()),
      r.stdout.trim())

    const short = runCli(['-v'])
    check('-v 等价于 --version', short.status === 0 && short.stdout.includes(PKG.version),
      `status=${short.status} out=${JSON.stringify(short.stdout.trim())}`)
  }

  // ────────────────────────────────────────────────────────────
  section('3. 未知参数:拒绝启动(退出码 2),不静默回退默认 store')
  // ────────────────────────────────────────────────────────────
  {
    const cases = [
      { argv: ['--nope'], expect: '--nope' },
      { argv: ['--store_dir', 'C:/tmp/x'], expect: '--store_dir' },   // 下划线笔误
      { argv: ['--storedir=C:/tmp/x'], expect: '--storedir' },        // 粘连笔误
      { argv: ['--storeD', 'C:/tmp/x'], expect: '--storeD' },
      { argv: ['--store-dir'], expect: '--store-dir' },               // 缺值
    ]
    for (const c of cases) {
      const r = runCli(c.argv)
      check(`未知/非法参数 ${c.argv[0]} ⇒ 退出码 2`, r.status === 2, `status=${r.status}`)
      check(`未知/非法参数 ${c.argv[0]} ⇒ stderr 提到参数名`, r.stderr.includes(c.expect),
        JSON.stringify(r.stderr.trim().split('\n').slice(0, 4).join(' | ')))
      check(`未知/非法参数 ${c.argv[0]} ⇒ 提示 --help`, r.stderr.includes('--help'), '')
      check(`未知/非法参数 ${c.argv[0]} ⇒ 不打印启动日志`, !r.stderr.includes('store-dir  ='), '')
    }
    // 极重要的安全性:笔误不能真的写出一个默认 store 目录。
    const probe = nonexistentPath('typo-store')
    const r = runCli(['--store_dir', probe])
    check('笔误参数不会创建任何目录', !existsSync(probe), `期望不存在:${probe}`)
    check('笔误参数不会走默认 store(未打印默认 store-dir)', !r.stderr.includes('store-dir  ='), '')
    rmSync(probe, { recursive: true, force: true })
  }

  // ────────────────────────────────────────────────────────────
  section('4. 启动失败诊断:store 目录不可建 ⇒ 中文提示、无裸栈')
  // ────────────────────────────────────────────────────────────
  {
    // ⚠️ 构造"建不出来"的路径必须**分平台**,否则这条用例在 Linux CI 上必然假红:
    //    `Q:/nope/store` 只在 Windows 是「盘符不存在」;在 POSIX 上 `Q:` 只是个普通目录名,
    //    resolve() 之后变成 `$PWD/Q:/nope/store`,mkdir **会成功** → 服务正常启动 → 6 条断言全崩。
    //    (2026-10-20 在 WSL Ubuntu + Node 24 上实测到过这个假红。)
    //    POSIX 侧不用 `/proc`(实测会卡住:procfs 里 mkdir 不返回),改用**父路径是普通文件**
    //    —— mkdir 必然 ENOTDIR,可控且不依赖权限位(CI 里可能以 root 跑,chmod 挡不住 root)。
    const isWin = process.platform === 'win32'
    let brokenStore
    let brokenParentFile = null
    if (isWin) {
      brokenStore = 'Q:/nope/store'
    } else {
      brokenParentFile = join(makeTempDir('broken-parent'), 'afile')
      writeFileSync(brokenParentFile, 'x')
      brokenStore = join(brokenParentFile, 'store')
    }
    const reasonPattern = isWin ? /盘符|父目录不存在/u : /父目录不存在|是个文件|创建失败|没有写入权限/u
    // 平台相关的错误码:Windows 是 ENOENT(盘符不存在),POSIX 上 ENOTDIR(父路径是文件)。
    const codePattern = isWin ? /ENOENT/u : /ENOTDIR|EACCES|EPERM|ENOENT/u

    const r = runCli(['--store-dir', brokenStore], { DSH_MEMORY_VECTOR: 'off' })
    check('不可建的 store-dir ⇒ 退出码 1', r.status === 1, `status=${r.status} target=${brokenStore}`)
    check('不可建的 store-dir ⇒ stderr 不含 4 空格缩进的栈帧', !hasStackFrames(r.stderr),
      r.stderr.trim().split('\n').slice(0, 3).join(' | '))
    check('不可建的 store-dir ⇒ 含可操作中文提示(改 --store-dir)',
      r.stderr.includes('--store-dir') && r.stderr.includes('⇒'), '')
    check('不可建的 store-dir ⇒ 说明原因',
      reasonPattern.test(r.stderr),
      r.stderr.trim().split('\n').find((l) => l.includes('原因')) ?? '(无原因行)')
    check('不可建的 store-dir ⇒ 最后附原始 error.code',
      codePattern.test(r.stderr), '')
    check('不可建的 store-dir ⇒ 未打印完整堆栈(不含 "    at ")',
      !/^\s{2,}at\s/mu.test(r.stderr), '')
    if (isWin) {
      check('不可建的 store-dir ⇒ 不会创建该目录', !existsSync(brokenStore), brokenStore)
    }

    // DSH_MEMORY_DEBUG=1 才打栈 —— 这是"默认不打栈"的反向证明。
    const dbg = runCli(['--store-dir', brokenStore], { DSH_MEMORY_VECTOR: 'off', DSH_MEMORY_DEBUG: '1' })
    check('DSH_MEMORY_DEBUG=1 ⇒ 才附带调用栈', dbg.status === 1 && hasStackFrames(dbg.stderr),
      `status=${dbg.status} hasStack=${hasStackFrames(dbg.stderr)}`)

    // ── 默认目录不可用时,文案必须给出**能走通**的指令 ──────────────
    // 真实场景(2026-10-20 实测):用户主目录不可写时,旧文案会说
    //   「改 --store-dir 指向…默认是 <同一个目录>」
    // —— 用户照着改只会原地打转。这条断言就是防它退回去。
    const { describeStartupError } = await import('../src/index.js')
    const mkErr = () => {
      const e = new Error("EPERM: operation not permitted, mkdir 'X'")
      e.code = 'EPERM'
      e.storeDir = DEFAULT_STORE_DIR
      return e
    }
    const asDefault = describeStartupError(Object.assign(mkErr(), { storeDirIsDefault: true }), { env: {} })
    const asExplicit = describeStartupError(Object.assign(mkErr(), { storeDirIsDefault: false }), { env: {} })
    const defText = asDefault.lines.join('\n')
    const expText = asExplicit.lines.join('\n')

    check('默认目录不可用 ⇒ 文案点明「你没有指定过它,用的是默认值」',
      defText.includes('没有指定过') && defText.includes('默认值'), '')
    check('默认目录不可用 ⇒ 要求**显式指定可写目录**,而不是叫用户改回默认目录',
      defText.includes('显式指定') && !defText.includes(`默认是 ${DEFAULT_STORE_DIR}`), '')
    check('默认目录不可用 + 权限错误 ⇒ 提示用户主目录本身可能不可写',
      defText.includes('主目录') && defText.includes(homedir()), '')
    check('显式指定目录不可用 ⇒ 仍给出「改 --store-dir」指引(不破坏原有路径)',
      expText.includes('改 --store-dir') && expText.includes('⇒'), '')
    check('两种诊断都只给 exit 1 且不含栈帧',
      asDefault.exitCode === 1 && asExplicit.exitCode === 1
      && !hasStackFrames(defText) && !hasStackFrames(expText), '')
  }

  // ────────────────────────────────────────────────────────────
  section('5. --project 不存在:告警但不阻止启动')
  // ────────────────────────────────────────────────────────────
  {
    const storeDir = makeTempDir('project-warn-store')
    assertNotRealStore(storeDir)
    const ghostProject = nonexistentPath('ghost-project')
    const r = runCli(
      ['--project', ghostProject, '--store-dir', storeDir, '--store-dir=' + storeDir],
      { DSH_MEMORY_VECTOR: 'off' },
    )
    check('--project 不存在 ⇒ 仍能启动(退出码 0)', r.status === 0, `status=${r.status}`)
    check('--project 不存在 ⇒ 打警告', r.stderr.includes('⚠️') && r.stderr.includes(ghostProject),
      r.stderr.trim().split('\n').filter((l) => l.includes('⚠️')).join(' | '))
    check('--project 不存在 ⇒ 提示改 --project / DSH_MEMORY_PROJECT',
      r.stderr.includes('DSH_MEMORY_PROJECT'), '')
    rmSync(ghostProject, { recursive: true, force: true })
  }

  // ────────────────────────────────────────────────────────────
  section('6. 等号形式(--key=value)端到端可用')
  // ────────────────────────────────────────────────────────────
  {
    const storeDir = makeTempDir('eq-store')
    const projectDir = makeTempDir('eq-project')
    assertNotRealStore(storeDir)
    const r = runCli([`--store-dir=${storeDir}`, `--project=${projectDir}`], { DSH_MEMORY_VECTOR: 'off' })
    check('等号形式 ⇒ 启动成功(退出码 0)', r.status === 0, `status=${r.status}`)
    check('等号形式 ⇒ store-dir 解析正确', r.stderr.includes(`store-dir  = ${storeDir}`),
      r.stderr.split('\n').find((l) => l.includes('store-dir')) ?? '')
    check('等号形式 ⇒ project 解析正确', r.stderr.includes(`project   = ${projectDir}`),
      r.stderr.split('\n').find((l) => l.includes('project   =')) ?? '')
    check('等号形式 ⇒ 真的在指定目录落盘(建了 projects/)',
      existsSync(join(storeDir, 'projects')), `期望存在:${join(storeDir, 'projects')}`)

    // 别名 + 等号(旧实现漏掉 `--store=` / `--project-dir=`,现在必须都认)
    const store2 = makeTempDir('eq-alias-store')
    const project2 = makeTempDir('eq-alias-project')
    assertNotRealStore(store2)
    const r2 = runCli([`--store=${store2}`, `--project-dir=${project2}`], { DSH_MEMORY_VECTOR: 'off' })
    check('别名 + 等号(--store= / --project-dir=)⇒ 退出码 0', r2.status === 0, `status=${r2.status}`)
    check('别名 + 等号 ⇒ store-dir 解析正确', r2.stderr.includes(`store-dir  = ${store2}`),
      r2.stderr.split('\n').find((l) => l.includes('store-dir')) ?? '')
    check('别名 + 等号 ⇒ project 解析正确', r2.stderr.includes(`project   = ${project2}`),
      r2.stderr.split('\n').find((l) => l.includes('project   =')) ?? '')
  }

  // ────────────────────────────────────────────────────────────
  section('7. 向量后端配置:不 spawn 真实 llama-server')
  // ────────────────────────────────────────────────────────────
  {
    const storeDir = makeTempDir('vec-store')
    assertNotRealStore(storeDir)
    const r = runCli(
      ['--store-dir', storeDir],
      {
        DSH_MEMORY_VECTOR: 'on',
        DSH_MEMORY_EMBED_EXE: 'C:\\nope\\llama-server.exe',
        DSH_MEMORY_EMBED_MODEL: 'C:\\nope\\model.gguf',
        DSH_MEMORY_EMBED_PORT: '58999', // 非默认端口,避免碰到真实的 8199/8078
        DSH_MEMORY_EMBED_ENDPOINT: '',  // 空 ⇒ 允许 spawn(用假 exe,立刻 ENOENT)
      },
    )
    check('假 exe ⇒ 服务仍能启动(向量退化为纯词法)', r.status === 0, `status=${r.status}`)
    check('假 exe ⇒ 日志说明"向量后端不可用,退化为纯词法检索"',
      r.stderr.includes('向量后端不可用') && r.stderr.includes('纯词法'),
      r.stderr.split('\n').filter((l) => l.includes('vector:')).join(' | '))
    check('假 exe ⇒ 不再出现 "已启动 llama-server pid=?"(pid 未分配时照实说)',
      !r.stderr.includes('pid=?') && !/已启动 llama-server pid=\?/u.test(r.stderr),
      r.stderr.split('\n').filter((l) => l.includes('llama-server')).join(' | '))
    check('假 exe ⇒ 不空转 120 秒(整体耗时 < 20 秒)',
      !r.error || r.error.code !== 'ETIMEDOUT',
      r.error ? `error=${r.error.code}` : 'ok')
  }

  // ────────────────────────────────────────────────────────────
  section('8. 缺依赖:--help 仍可用,正常启动给友好提示')
  // ────────────────────────────────────────────────────────────
  {
    // 模拟"npm install 没装 / 部署时只复制了 src/ 漏了 node_modules"。
    //
    // ⚠️ 刻意**不去改真实 node_modules**(早期版本把 SDK 改名成 sdk.__selftest_bak,
    //    实测在这个窗口期内被 Ctrl-C / SIGKILL 会留下"依赖凭空消失"的破损状态,
    //    后续所有脚本一起挂)。改成把 src/ + package.json 复制到 tmpdir 下 ——
    //    那里的祖先目录没有 node_modules,ESM 解析必然失败,效果等价且零破坏。
    const nodep = makeTempDir('nodep-root')
    cpSync(join(ROOT, 'src'), join(nodep, 'src'), { recursive: true })
    cpSync(join(ROOT, 'package.json'), join(nodep, 'package.json'))
    const entry = join(nodep, 'src', 'index.js')

    /** 在"无依赖副本"里起子进程。 */
    const runCopy = (args) => {
      const res = spawnSync(process.execPath, [entry, ...args], {
        cwd: nodep, encoding: 'utf8', input: '', timeout: 20_000, env: baseEnv(),
      })
      return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', error: res.error }
    }

    check('无依赖副本确实不含 node_modules', !existsSync(join(nodep, 'node_modules')), `路径:${nodep}`)

    const h = runCopy(['--help'])
    check('缺依赖时 --help 仍能退出 0(在动态 import 之前处理)',
      h.status === 0, `status=${h.status}${h.error ? ` error=${h.error.message}` : ''}`)
    check('缺依赖时 --help 仍打出用法', h.stdout.includes('--store-dir') && h.stdout.includes('DSH_MEMORY_'),
      `stdout ${h.stdout.length} 字节`)
    check('缺依赖时 --help 无裸栈', !hasStackFrames(h.stderr) && h.stderr.trim() === '',
      h.stderr.slice(0, 160))

    const v = runCopy(['--version'])
    check('缺依赖时 --version 仍能退出 0', v.status === 0 && v.stdout.includes(PKG.version),
      `status=${v.status} out=${JSON.stringify(v.stdout.trim())}`)

    const storeDir = join(nodep, 'store')
    assertNotRealStore(storeDir)
    const r = runCopy(['--store-dir', storeDir])
    check('缺依赖时正常启动 ⇒ 退出码 1', r.status === 1, `status=${r.status}`)
    check('缺依赖时 ⇒ 友好中文提示(提到 npm install)',
      r.stderr.includes('npm install') && r.stderr.includes('依赖'),
      r.stderr.trim().split('\n').slice(-4).join(' | '))
    check('缺依赖时 ⇒ 不打印 ERR_MODULE_NOT_FOUND 裸栈',
      !hasStackFrames(r.stderr) && !/node:internal\/modules/u.test(r.stderr),
      r.stderr.trim().split('\n').slice(0, 3).join(' | '))
    check('缺依赖时 ⇒ 不会建出 store 目录', !existsSync(storeDir), `期望不存在:${storeDir}`)

    // 反向证明:真实依赖全程没被动过、也没被弄丢。
    // ⚠️ 判据是「Node 还能解析到这个包」,不是「ROOT/node_modules 下有这个目录」——
    //    作为依赖被装进别的项目时,node_modules 是平铺的,本包自己那层根本不存在。
    check('依赖仍可解析且未被改名(本节零副作用)',
      dependencyResolvable() && !existsSync(SDK_BAK),
      `resolvable=${dependencyResolvable()} bak=${existsSync(SDK_BAK)} sdkDir=${existsSync(SDK_DIR)}`)
  }

  // ────────────────────────────────────────────────────────────
  section('9. 纯函数:parseArgs')
  // ────────────────────────────────────────────────────────────
  {
    const empty = parseArgs([])
    check('parseArgs([]) 各字段为空',
      empty.project === undefined && empty.storeDir === undefined && empty.help === false
      && empty.version === false && empty.unknown.length === 0 && empty.missing.length === 0,
      JSON.stringify(empty))

    const spaced = parseArgs(['--project', 'A', '--store-dir', 'B'])
    check('parseArgs 空格形式', spaced.project === 'A' && spaced.storeDir === 'B', JSON.stringify(spaced))

    const eq = parseArgs(['--project=A', '--store-dir=B'])
    check('parseArgs 等号形式', eq.project === 'A' && eq.storeDir === 'B', JSON.stringify(eq))

    const aliases = parseArgs(['--project-dir', 'A', '--store', 'B'])
    check('parseArgs 别名 --project-dir / --store',
      aliases.project === 'A' && aliases.storeDir === 'B', JSON.stringify(aliases))

    const aliasEq = parseArgs(['--project-dir=A', '--store=B'])
    check('parseArgs 别名 + 等号(--project-dir= / --store=)',
      aliasEq.project === 'A' && aliasEq.storeDir === 'B', JSON.stringify(aliasEq))

    const help = parseArgs(['-h'])
    const helpLong = parseArgs(['--help'])
    check('parseArgs -h / --help', help.help === true && helpLong.help === true, '')
    check('parseArgs -v / --version', parseArgs(['-v']).version === true && parseArgs(['--version']).version === true, '')

    const unknown = parseArgs(['--nope', '--store_dir', 'X'])
    check('parseArgs 收集未知参数(不静默吞掉)',
      unknown.unknown.length === 2 && unknown.unknown.includes('--nope') && unknown.unknown.includes('--store_dir'),
      JSON.stringify(unknown.unknown))

    // 未知 flag + 取值:只报 flag 本身,不把值也算成"未知参数"(否则报错信息会误导)。
    const unknownWithValue = parseArgs(['--store_dir', 'D:\\x'])
    check('parseArgs 未知 flag 的取值不被误报为未知参数',
      unknownWithValue.unknown.length === 1 && unknownWithValue.unknown[0] === '--store_dir',
      JSON.stringify(unknownWithValue.unknown))

    const eqUnknown = parseArgs(['--storedir=C:/x'])
    check('parseArgs 未知等号参数报参数名(不含 =值)',
      eqUnknown.unknown.length === 1 && eqUnknown.unknown[0] === '--storedir',
      JSON.stringify(eqUnknown.unknown))

    const missing = parseArgs(['--store-dir'])
    check('parseArgs 缺值进 missing', missing.missing.length === 1 && missing.missing[0] === '--store-dir',
      JSON.stringify(missing.missing))

    const missingEmpty = parseArgs(['--store-dir='])
    check('parseArgs 空值(--store-dir=)进 missing', missingEmpty.missing.length === 1, JSON.stringify(missingEmpty))

    const missingThenFlag = parseArgs(['--store-dir', '--help'])
    check('parseArgs 值位置是另一个 flag ⇒ 不算值,进 missing 且保留 --help',
      missingThenFlag.missing[0] === '--store-dir' && missingThenFlag.help === true
      && missingThenFlag.storeDir === undefined,
      JSON.stringify(missingThenFlag))

    const repeated = parseArgs(['--store-dir', 'A', '--store-dir', 'B'])
    check('parseArgs 重复参数以最后一次为准(不静默拼接)', repeated.storeDir === 'B', JSON.stringify(repeated))

    // 位置参数(无 -- 前缀)也算未知:宁可报错,也不要悄悄当成上一条 flag 的值。
    const positional = parseArgs(['C:/some/dir'])
    check('parseArgs 多余位置参数进 unknown', positional.unknown.length === 1, JSON.stringify(positional.unknown))
  }

  // ────────────────────────────────────────────────────────────
  section('10. 纯函数:resolveConfig(默认值 / 优先级 / 解析规则)')
  // ────────────────────────────────────────────────────────────
  {
    const cleanEnv = {} // 完全干净的环境

    const def = resolveConfig([], cleanEnv)
    check('默认 projectBasePath = process.cwd()', def.projectBasePath === resolve(process.cwd()),
      def.projectBasePath)
    check('默认 storeDir = DEFAULT_STORE_DIR', def.storeDir === resolve(DEFAULT_STORE_DIR), def.storeDir)
    // ⚠️ 默认值必须是**平台中立**的 ~/.dsh-memory-store,不能是作者本机路径 ——
    // clone 下来直接跑的人:Windows 上没 D 盘会 ENOENT,Linux/macOS 上会建出名叫 `D:` 的垃圾目录。
    check('默认 storeDir 落在用户主目录下(homedir/.dsh-memory-store)',
      def.storeDir === resolve(homedir(), '.dsh-memory-store'),
      `${def.storeDir}(homedir=${homedir()})`)
    check('默认 storeDir 不含写死的盘符路径(旧版 D:/dev/... 不得回归)',
      !/^[A-Za-z]:[\\/]+dev[\\/]/u.test(def.storeDir),
      def.storeDir)
    check('默认 defaultSaveScope = global', def.defaultSaveScope === 'global', def.defaultSaveScope)

    // env 层
    const fromEnv = resolveConfig([], { DSH_MEMORY_PROJECT: 'C:/env/proj', DSH_MEMORY_STORE_DIR: 'C:/env/store' })
    check('env 覆盖默认 project', fromEnv.projectBasePath === resolve('C:/env/proj'), fromEnv.projectBasePath)
    check('env 覆盖默认 store', fromEnv.storeDir === resolve('C:/env/store'), fromEnv.storeDir)

    // argv > env
    const argvWins = resolveConfig(
      ['--project', 'C:/argv/proj', '--store-dir', 'C:/argv/store'],
      { DSH_MEMORY_PROJECT: 'C:/env/proj', DSH_MEMORY_STORE_DIR: 'C:/env/store' },
    )
    check('argv > env(project)', argvWins.projectBasePath === resolve('C:/argv/proj'), argvWins.projectBasePath)
    check('argv > env(store)', argvWins.storeDir === resolve('C:/argv/store'), argvWins.storeDir)

    // env > 默认
    const envWins = resolveConfig([], { DSH_MEMORY_STORE_DIR: 'C:/env/store' })
    check('env > 默认(store)', envWins.storeDir === resolve('C:/env/store'), envWins.storeDir)

    // 别名 + 等号都走同一条路
    const viaAlias = resolveConfig(['--project-dir', 'C:/a', '--store', 'C:/b'], cleanEnv)
    check('别名解析(纯函数)', viaAlias.projectBasePath === resolve('C:/a') && viaAlias.storeDir === resolve('C:/b'),
      JSON.stringify(viaAlias))

    // 相对路径:store 按 cwd,project 同样按 cwd(与 README/AGENTS 的口径一致)
    const rel = resolveConfig(['--project', 'sub/proj', '--store-dir', 'rel/store'], cleanEnv)
    check('相对 --project 按 process.cwd() 解析', rel.projectBasePath === resolve('sub/proj'),
      rel.projectBasePath)
    check('相对 --store-dir 按 process.cwd() 解析', rel.storeDir === resolve('rel/store'), rel.storeDir)

    // DSH_MEMORY_SCOPE_ALL 真值表
    const truthyValues = ['1', 'true', 'yes', 'on', 'TRUE', ' Yes ', 'ON']
    const falsyValues = ['', '0', 'false', 'no', 'off', 'disabled', '2', 'trueish', 'y', 'truthy']
    const truthyOk = truthyValues.every((v) => resolveConfig([], { DSH_MEMORY_SCOPE_ALL: v }).defaultSaveScope === 'project')
    const falsyOk = falsyValues.every((v) => resolveConfig([], { DSH_MEMORY_SCOPE_ALL: v }).defaultSaveScope === 'global')
    check('DSH_MEMORY_SCOPE_ALL 真值表(1/true/yes/on + 大小写/空格)⇒ project', truthyOk,
      truthyValues.join(','))
    check('DSH_MEMORY_SCOPE_ALL 其它值(含 0/no/off/空串)⇒ global', falsyOk, falsyValues.join(','))
    check('DSH_MEMORY_SCOPE_ALL 未设置 ⇒ global',
      resolveConfig([], {}).defaultSaveScope === 'global', '')

    // 返回值形状:只暴露三个键(改结构时这条会先报警)
    check('resolveConfig 返回 { projectBasePath, storeDir, defaultSaveScope }',
      JSON.stringify(Object.keys(def).sort()) === JSON.stringify(['defaultSaveScope', 'projectBasePath', 'storeDir']),
      JSON.stringify(Object.keys(def)))
    check('resolveConfig 返回绝对路径',
      def.projectBasePath === resolve(def.projectBasePath) && def.storeDir === resolve(def.storeDir), '')
  }

  // ────────────────────────────────────────────────────────────
  section('11. 无副作用确认')
  // ────────────────────────────────────────────────────────────
  {
    check('真实 store 目录里没有本脚本造的标记', !existsSync(join(DEFAULT_STORE_DIR, '.selftest-cli-marker')),
      '(仅检查测试专属标记文件)')
    // 帮助文本必须与解析器一致:帮助里提到的每个 flag 都必须真的能被解析。
    const help = runCli(['--help']).stdout
    const flagsInHelp = [...new Set(help.match(/--[a-z][a-z-]*/gu) ?? [])].filter((f) => f !== '--help' && f !== '--version')
    const parseable = flagsInHelp.every((f) => {
      const parsed = parseArgs([`${f}=X`, f, 'X'])
      return parsed.unknown.length === 0 && (parsed.project === 'X' || parsed.storeDir === 'X')
    })
    check('帮助文本里提到的启动参数都能被 parseArgs 解析(文档不撒谎)', parseable,
      `flags=${flagsInHelp.join(', ')}`)
    check('向量相关的 DSH_MEMORY_EMBED_* 在帮助里有列出',
      ['DSH_MEMORY_EMBED_EXE', 'DSH_MEMORY_EMBED_MODEL', 'DSH_MEMORY_EMBED_PORT', 'DSH_MEMORY_EMBED_POOLING']
        .every((k) => help.includes(k)), '')
  }
} catch (error) {
  console.error('\n自测异常终止:', error)
  failures++
} finally {
  // 兜底:只有当 SDK 真的缺失、而备份还在时(说明被外部操作弄乱),才改名还原。
  // 本脚本自己**不会**制造这个状态 —— 它复制 src/ 到 tmpdir 来模拟缺依赖,不碰真实 node_modules。
  if (existsSync(SDK_BAK) && !existsSync(SDK_DIR)) {
    try {
      renameSync(SDK_BAK, SDK_DIR)
      console.log('  ⚠️ 检测到 SDK 目录停在改名状态(非本脚本所为),已改回')
    } catch (error) {
      console.error(`\n⛔ 还原 @modelcontextprotocol/sdk 失败,请手工执行:\n  ${SDK_BAK} → ${SDK_DIR}\n${error.message}`)
    }
  }
  if (!keep) {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        // 清理失败不影响判定
      }
    }
  } else {
    console.log(`\n(--keep)保留临时目录:\n  ${tempDirs.join('\n  ')}`)
  }
}

// 最后再确认一次:没有任何残留的临时 store 目录被留下来。
const leftovers = tempDirs.filter((d) => !keep && existsSync(d))
if (leftovers.length > 0) {
  console.log(`\n⚠️  临时目录未清理干净:${leftovers.join(', ')}`)
}

const passed = results.length - failures
console.log(`\n${'─'.repeat(78)}`)
if (failures > 0) {
  console.log(`共 ${results.length} 项检查,通过 ${passed}/${results.length},失败 ${failures} 项。`)
  console.log('\n失败项:')
  for (const r of results.filter((x) => !x.ok)) console.log(`  ✗ ${r.name}\n      ${r.detail}`)
} else {
  console.log(`通过 ${passed}/${results.length} 项检查。`)
}
process.exit(failures > 0 ? 1 : 0)
