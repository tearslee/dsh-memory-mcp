/**
 * 部署自检 —— 装完之后先跑这个,确认"装对了没"。
 *
 * 用法:node scripts/check-install.mjs
 * 退出码:0 = 全部通过;1 = 有问题(会说明改什么)。
 *
 * 为什么不用 `npm ls @modelcontextprotocol/sdk --depth=0`:
 *   从 npm 装进别的项目时 node_modules 是**平铺(hoisted)**的,本包目录下没有自己的
 *   node_modules,`npm ls` 会打出 `-- (empty)` —— 那表示"依赖被提升到上一层",
 *   **不是**"没装"。用 Node 自己的解析算法(import.meta.resolve)在两种布局下都准。
 *
 * Copyright (c) 2026 restlear
 * SPDX-License-Identifier: MIT
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

let failed = 0
function ok(label, detail = '') {
  console.log(`  ✅ ${label}${detail ? `\n     ${detail}` : ''}`)
}
function bad(label, fix) {
  failed++
  console.log(`  ❌ ${label}${fix ? `\n     ⇒ ${fix}` : ''}`)
}

console.log('═'.repeat(70))
console.log(`  部署自检 —— ${pkg.name} ${pkg.version}`)
console.log('═'.repeat(70))

// ── 1. Node 版本 ───────────────────────────────────────────────
// 下限由源码里真实用到的 API 决定(见 README「安装」一节的说明),
// 不在这里再写一份实现,直接比 engines。
{
  const need = String(pkg.engines?.node ?? '').replace(/^[>=^~]+/u, '')
  const [maj, min] = String(process.versions.node).split('.').map(Number)
  const [needMaj, needMin] = need.split('.').map((x) => Number(x || 0))
  const enough = maj > needMaj || (maj === needMaj && min >= needMin)
  if (enough) ok(`Node 版本 ${process.versions.node}(要求 >= ${need})`)
  else bad(`Node 版本过低:当前 ${process.versions.node},要求 >= ${need}`,
    '升级 Node;低于它会在向量检索时才炸,很难定位')
}

// ── 2. 依赖能不能解析到 ─────────────────────────────────────────
{
  let entry = null
  try {
    entry = import.meta.resolve('@modelcontextprotocol/sdk')
  } catch {
    bad('@modelcontextprotocol/sdk 解析失败',
      `在 ${ROOT} 运行 npm install(依赖不随 src/ 一起复制)`)
  }
  if (entry) {
    // 往上找它的 package.json 读真实版本。SDK 的 exports 不暴露 ./package.json,
    // 所以不能 require('.../package.json') —— 只能顺着入口路径往上找。
    let version = '(未知)'
    let d = dirname(fileURLToPath(entry))
    for (let i = 0; i < 8; i++) {
      const f = join(d, 'package.json')
      if (existsSync(f)) {
        try {
          const j = JSON.parse(readFileSync(f, 'utf8'))
          if (j.name === '@modelcontextprotocol/sdk') { version = j.version; break }
        } catch { /* 继续往上 */ }
      }
      const up = dirname(d)
      if (up === d) break
      d = up
    }
    const want = pkg.dependencies?.['@modelcontextprotocol/sdk']
    const match = !want || version === want
    if (match) ok(`依赖 @modelcontextprotocol/sdk ${version}`, entry)
    else bad(`依赖版本不符:装的是 ${version},package.json 要求 ${want}`, '重新 npm install')
  }
}

// ── 3. CLI 能不能自描述 ────────────────────────────────────────
// 这一步只读 package.json,不加载 SDK、不建目录 —— 所以它坏了一定是文件缺失。
{
  if (existsSync(join(ROOT, 'src', 'index.js'))) {
    ok('入口 src/index.js 存在', '试跑:node src/index.js --version')
  } else {
    bad('入口 src/index.js 不存在', '仓库不完整,重新 clone 或重新安装')
  }
}

// ── 4. 会落到哪个 storeDir(最容易错的一步)────────────────────
// 只做**字符串层面**的判断,不创建任何目录、不碰真实记忆库。
{
  const fromArgv = process.argv.slice(2)
  const idx = fromArgv.findIndex((a) => a === '--store-dir' || a === '--store')
  const explicit = idx >= 0 ? fromArgv[idx + 1] : (fromArgv.find((a) => a.startsWith('--store-dir='))?.split('=')[1])
  const fromEnv = process.env.DSH_MEMORY_STORE_DIR
  const effective = explicit || fromEnv || join(homedir(), '.dsh-memory-store')

  if (explicit || fromEnv) {
    ok(`storeDir = ${resolve(effective)}`, `来源:${explicit ? '启动参数' : 'DSH_MEMORY_STORE_DIR'}`)
  } else {
    console.log(`  ⚠️  storeDir = ${resolve(effective)}`)
    console.log('     ⇒ 这是**默认值**。它只保证能跑,不保证就是你 DSH 在用的那个库。')
    console.log('     ⇒ 要与 DSH 共用记忆,请显式设置 --store-dir 或 DSH_MEMORY_STORE_DIR')
    console.log('       指向 DSH 记忆插件的 storeDir(DSH 里「设置 → 记忆」可查)。')
  }

  // 只读探测:这个目录看起来是不是一个真的记忆库(有 global.jsonl)。
  const looksLikeStore = existsSync(join(resolve(effective), 'global.jsonl'))
  const exists = existsSync(resolve(effective))
  if (!exists) {
    console.log('     (该目录还不存在 —— 首次启动时会自动创建)')
  } else if (looksLikeStore) {
    console.log('     ✓ 该目录里有 global.jsonl,看起来是一份已有的记忆库')
  } else {
    console.log('     (目录存在但没有 global.jsonl —— 可能是新建的空库)')
  }
}

console.log('═'.repeat(70))
if (failed === 0) {
  console.log('  自检通过。下一步:在 IDE 的 mcp.json 里配上 command/args(见 README)。')
  process.exit(0)
} else {
  console.log(`  ${failed} 项未通过,先按上面的 ⇒ 修掉再配 IDE。`)
  process.exit(1)
}
