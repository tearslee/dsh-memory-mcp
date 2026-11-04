#!/usr/bin/env node
/**
 * `.workbuddy` → dsh-memory project 域索引 CLI。
 *
 * 核心实现位于 `src/workbuddy-index.js`，与 MCP `memory_index` 共用。
 * CLI 写入默认需要显式 store/project；`--dry-run` 不创建任何目录。
 */
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SharedStore } from '../src/store.js'
import { normalizeProjectPath, projectScopeKey } from '../src/tools.js'
import { VectorBackend } from '../src/vector.js'
import {
  applyIndexPlan,
  buildIndexPlan,
  defaultStatusSince,
  inspectIndex,
  normalizeIndexSources,
  normalizeSince,
  readScopeReadOnly,
  redactSecrets,
  splitMarkdownSections,
} from '../src/workbuddy-index.js'

export { redactSecrets, splitMarkdownSections }

function usage() {
  return `用法:
  node scripts/index-workbuddy.mjs --project <dir> --store-dir <dir> [选项]

必填:
  --project <dir>       项目根目录；也可用 DSH_MEMORY_PROJECT
  --store-dir <dir>     dsh-memory store 根目录；也可用 DSH_MEMORY_STORE_DIR
                        ⚠️ 必须显式给出，且目录必须已存在；脚本不会新建 store 根目录

选项:
  --memory-dir <dir>    默认 <project>/.workbuddy/memory
  --sources <csv>       daily,detail,rules；默认 daily
  --files <csv>         只索引指定文件，例如 2026-11-02.md,2026-11-03.md
  --since <yyyy-mm-dd>  只索引日期 >= since 的日报
  --max-chars <n>       单条正文上限；默认 0 = 不截断
  --no-vector           只写词法索引，不生成/追加 .vec 向量
  --dry-run             只打印计划，不写 store
  --status              只检查新鲜度/孤儿，不写 store
  -h, --help            打印本帮助
`
}

/**
 * 解析 `--key value` / `--key=value`。未知参数与缺值一律报错。
 * @param {string[]} argv
 */
export function parseArgs(argv = []) {
  const valueFlags = new Set([
    '--project', '--project-dir', '--store-dir', '--store', '--memory-dir',
    '--sources', '--files', '--since', '--max-chars',
  ])
  const boolFlags = new Set(['--dry-run', '--no-vector', '--status', '-h', '--help'])
  const out = {
    project: undefined,
    storeDir: undefined,
    memoryDir: undefined,
    sources: undefined,
    files: undefined,
    since: undefined,
    maxChars: 0,
    dryRun: false,
    noVector: false,
    status: false,
    help: false,
  }
  const unknown = []
  const missing = []

  const assign = (flag, value) => {
    switch (flag) {
      case '--project':
      case '--project-dir':
        out.project = value
        break
      case '--store-dir':
      case '--store':
        out.storeDir = value
        break
      case '--memory-dir':
        out.memoryDir = value
        break
      case '--sources':
        out.sources = value
        break
      case '--files':
        out.files = value
        break
      case '--since':
        out.since = value
        break
      case '--max-chars': {
        const n = Number(value)
        if (!Number.isInteger(n) || n < 0) throw new Error(`--max-chars 必须是非负整数，实际为 ${JSON.stringify(value)}`)
        out.maxChars = n
        break
      }
      default:
        unknown.push(flag)
    }
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i])
    if (boolFlags.has(arg)) {
      if (arg === '-h' || arg === '--help') out.help = true
      else if (arg === '--dry-run') out.dryRun = true
      else if (arg === '--no-vector') out.noVector = true
      else if (arg === '--status') out.status = true
      continue
    }
    const eq = arg.indexOf('=')
    if (arg.startsWith('--') && eq > 0) {
      const flag = arg.slice(0, eq)
      const value = arg.slice(eq + 1)
      if (!valueFlags.has(flag)) {
        unknown.push(arg)
        continue
      }
      if (value === '') {
        missing.push(flag)
        continue
      }
      assign(flag, value)
      continue
    }
    if (valueFlags.has(arg)) {
      const next = argv[i + 1]
      if (next === undefined || String(next).startsWith('--')) {
        missing.push(arg)
        continue
      }
      assign(arg, String(next))
      i++
      continue
    }
    unknown.push(arg)
  }

  if (unknown.length > 0) throw new Error(`未知参数:${unknown.join(' ')}`)
  if (missing.length > 0) throw new Error(`参数缺值:${missing.join(' ')}`)
  return out
}

function summarizePlan(plan) {
  const counts = { new: 0, supersede: 0, skip: 0 }
  for (const item of plan) counts[item.action]++
  return counts
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(usage())
    return { exitCode: 0 }
  }

  const projectRaw = args.project || env.DSH_MEMORY_PROJECT
  const storeRaw = args.storeDir || env.DSH_MEMORY_STORE_DIR
  if (!projectRaw) throw new Error('缺少 --project（或 DSH_MEMORY_PROJECT）')
  if (!storeRaw) throw new Error('缺少 --store-dir（或 DSH_MEMORY_STORE_DIR）；为防误写，必须显式指定')

  const projectDir = normalizeProjectPath(projectRaw, process.cwd())
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) throw new Error(`project 不存在或不是目录:${projectDir}`)
  const storeDir = resolve(storeRaw)
  if (!existsSync(storeDir) || !statSync(storeDir).isDirectory()) {
    throw new Error(`store-dir 不存在或不是目录:${storeDir}（脚本不会自动创建 store 根目录）`)
  }

  const memoryDir = resolve(args.memoryDir || join(projectDir, '.workbuddy', 'memory'))
  const sources = normalizeIndexSources(args.sources)
  const since = normalizeSince(args.since)
    ?? (args.status && args.sources === undefined ? defaultStatusSince() : undefined)
  const scope = projectScopeKey(projectDir)
  const records = args.dryRun || args.status
    ? readScopeReadOnly(storeDir, scope)
    : [...new SharedStore(storeDir).readScope(scope).values()]

  if (args.status) {
    const status = inspectIndex({
      projectDir, memoryDir, sources, files: args.files, since, records,
    })
    console.log(`scope: ${scope}`)
    console.log(`files: ${status.files.length}, sections: ${status.plan.length}`)
    console.log(`counts: ${status.counts.new} new, ${status.counts.supersede} supersede, ${status.counts.skip} skip`)
    console.log(`stale: ${status.stale}, activeIndexed: ${status.activeIndexed}, orphans: ${status.orphans.length}, missingSources: ${status.missingSources.length}`)
    for (const item of status.plan.filter((entry) => entry.action !== 'skip')) {
      console.log(`[${item.action}] ${item.relativePath}#${item.heading}`)
    }
    return { exitCode: status.stale === 0 ? 0 : 2, status, scope }
  }

  const built = buildIndexPlan({
    projectDir, memoryDir, sources, files: args.files, since, maxChars: args.maxChars, records,
  })
  const counts = summarizePlan(built.plan)
  for (const item of built.plan) {
    const label = item.action === 'new' ? '新增' : item.action === 'supersede' ? '替换' : '跳过'
    console.log(`[${label}] ${item.relativePath}#${item.heading} chars=${item.content.length} hash=${item.hash.slice(0, 8)}`)
  }
  console.log(`\nscope: ${scope}`)
  console.log(`files: ${built.files.map((file) => file.relativePath).join(', ')}`)
  console.log(`plan: ${counts.new} new, ${counts.supersede} supersede, ${counts.skip} skip`)

  if (args.dryRun) {
    console.log('dry-run: 未写入 store')
    return { exitCode: 0, plan: built.plan, scope, counts }
  }

  const vector = args.noVector ? null : new VectorBackend({ root: storeDir }, env)
  const store = new SharedStore(storeDir, {
    vecIdentity: vector ? `${vector.cfg.modelName}\t${vector.cfg.dims}` : undefined,
  })
  try {
    const applied = await applyIndexPlan({ store, scope, plan: built.plan, vector, noVector: args.noVector })
    console.log(`\n写入完成: ${applied.counts.new} new, ${applied.counts.supersede} supersede, ${applied.counts.skip} skip`)
    console.log(applied.vectors.disabled
      ? 'vector: 已禁用(--no-vector)'
      : `vector: ${applied.vectors.appended} appended, ${applied.vectors.failed} failed, ${applied.vectors.skipped} already present`)
    return { exitCode: 0, plan: built.plan, scope, counts: applied.counts, vectors: applied.vectors }
  } finally {
    vector?.stop()
  }
}

const invokedDirectly = Boolean(process.argv[1])
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (invokedDirectly) {
  main().then(
    (result) => {
      process.exitCode = result.exitCode ?? 0
    },
    (error) => {
      console.error(`[index-workbuddy] ❌ ${error?.message ?? error}`)
      if (process.env.DSH_MEMORY_DEBUG === '1') console.error(error?.stack ?? error)
      process.exitCode = 1
    },
  )
}
