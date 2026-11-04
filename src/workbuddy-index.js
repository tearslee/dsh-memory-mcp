/**
 * `.workbuddy` → dsh-memory project 域的派生索引器。
 *
 * 这里是**唯一实现**：CLI 与 MCP 工具都调用本模块，避免两套切分/哈希/去重逻辑漂移。
 *
 * 硬约束：
 *   1. 只写调用方给出的 project scope，绝不写 global；
 *   2. 按 Markdown `##` 章节切分，不整篇搬运；
 *   3. 每条带 `来源:<相对路径>#<标题>` + `hash:<sha1>`；
 *   4. 同来源 hash 变化时用完整 UUID `supersedes`；
 *   5. 不索引 `MEMORY.md` / `STATE.md` / `done-log` / secrets；
 *   6. 默认不自动建 store；MCP 写入默认 dry-run，必须显式确认。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { scopeFileName } from './store.js'

export const INDEX_SOURCES = ['daily', 'detail', 'rules']
export const DEFAULT_INDEX_SOURCES = ['daily']
export const DEFAULT_STATUS_SOURCES = ['daily', 'detail', 'rules']
const DAILY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/u
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u
const SOURCE_TAG_PREFIX = '来源:'
const SKIP_NAMES = new Set(['secrets.local.md'])
const SKIP_DETAIL_NAMES = new Set(['00-done-log.md'])

/**
 * 默认新鲜度检查窗口：只看最近 2 天日报，避免把「历史日报尚未全量索引」误报成
 * 每次收尾都必须清掉的 stale。需要全量检查时显式传 since 或 sources。
 */
export function defaultStatusSince(now = new Date()) {
  const date = new Date(now.getTime())
  date.setDate(date.getDate() - 2)
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/**
 * 解析 sources 参数；既接受数组，也接受 CSV 字符串。
 * @param {string[]|string|undefined} raw
 * @param {string[]} fallback
 * @returns {string[]}
 */
export function normalizeIndexSources(raw, fallback = DEFAULT_INDEX_SOURCES) {
  const values = raw === undefined || raw === null || raw === ''
    ? fallback
    : (Array.isArray(raw) ? raw : String(raw).split(','))
  const sources = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))]
  if (sources.length === 0) throw new Error('sources 不能为空')
  for (const source of sources) {
    if (!INDEX_SOURCES.includes(source)) {
      throw new Error(`sources 只能是 ${INDEX_SOURCES.join(' / ')}，收到 ${JSON.stringify(source)}`)
    }
  }
  return sources
}

/**
 * 校验日期参数。
 * @param {string|undefined} value
 * @returns {string|undefined}
 */
export function normalizeSince(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined
  const since = String(value).trim()
  if (!DATE_RE.test(since)) throw new Error(`since 必须是 YYYY-MM-DD，收到 ${JSON.stringify(since)}`)
  return since
}

/** @param {string} text */
function sha1(text) {
  return createHash('sha1').update(text).digest('hex')
}

/**
 * 基础凭据脱敏。只处理“键 + 值”的显式形式，避免误伤普通业务文案。
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text) {
  let out = String(text ?? '')
  out = out.replace(
    /(\b(?:password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|access[_-]?key|private[_-]?key)\b|密码|口令|令牌)(\s*[:=：]\s*)(["']?)([^\s,;，；"'`]+)\3/giu,
    (_match, key, separator, quote) => `${key}${separator}${quote}<密码>${quote}`,
  )
  out = out.replace(/(\bBearer\s+)([A-Za-z0-9._~+/-]+=*)/giu, '$1<密码>')
  out = out.replace(/((?:https?|ftp|ssh):\/\/[^/\s:@]+:)([^@\s/]+)(@)/giu, '$1<密码>$3')
  out = out.replace(
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
    '<密码:PRIVATE KEY>',
  )
  return out
}

/**
 * 按 Markdown 二级标题切分。忽略 fenced code block 里的 `##`。
 * @param {string} text
 * @returns {{ heading: string, body: string }[]}
 */
export function splitMarkdownSections(text) {
  const source = String(text ?? '').replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n')
  const lines = source.split('\n')
  const sections = []
  let current = null
  let fence = null

  const finish = () => {
    if (!current) return
    const body = current.body.join('\n').trim()
    if (body !== '') sections.push({ heading: current.heading, body })
    current = null
  }

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/u)
    if (fence) {
      current?.body.push(line)
      if (fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length) fence = null
      continue
    }
    if (fenceMatch) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length }
      current?.body.push(line)
      continue
    }

    const headingMatch = line.match(/^##(?!#)\s+(.+?)\s*$/u)
    if (headingMatch) {
      finish()
      const heading = headingMatch[1].replace(/\s+#+\s*$/u, '').trim()
      current = { heading, body: [] }
      continue
    }
    current?.body.push(line)
  }
  finish()
  return sections
}

/**
 * @param {string} body
 * @param {number} maxChars
 */
function limitContent(body, maxChars) {
  if (!maxChars || body.length <= maxChars) return body
  const suffix = '\n\n…[truncated by workbuddy-index]'
  return body.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd() + suffix
}

/** 事故 / 生产 / 决策类章节提高重要度；但不把 rules 变成 kind=rule。 */
function importanceFor(heading, body) {
  const text = `${heading}\n${body}`
  if (/(🔴|事故|故障|根因|回滚|回退|数据丢失|安全|生产回切|拍板|红线)/u.test(text)) return 0.8
  if (/(部署|上线|发布|数据库|备份|优化|性能|VPS|服务器)/iu.test(text)) return 0.72
  return 0.65
}

/** @param {string} relativePath @param {string} heading */
function sourceTagOf(relativePath, heading) {
  return `${SOURCE_TAG_PREFIX}${relativePath}#${heading}`
}

/** @param {string} relativePath */
export function sourceKindOf(relativePath) {
  if (/\.workbuddy\/memory\/\d{4}-\d{2}-\d{2}\.md$/u.test(relativePath)) return 'daily'
  if (relativePath.startsWith('.workbuddy/memory/detail/')) return 'detail'
  if (relativePath.startsWith('.workbuddy/rules/')) return 'rules'
  return null
}

function normalizeRelative(projectDir, fullPath) {
  return relative(projectDir, fullPath).split(/[\\/]/u).join('/')
}

function listMarkdownFiles(dir, { detail = false } = {}) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md') && !SKIP_NAMES.has(name)
      && !(detail && SKIP_DETAIL_NAMES.has(name)))
    .map((name) => join(dir, name))
    .filter((file) => existsSync(file) && statSync(file).isFile())
}

/**
 * 解析待索引文件。
 * @param {{projectDir:string,memoryDir:string,sources:string[],files?:string[],since?:string}} options
 */
export function resolveIndexFiles({ projectDir, memoryDir, sources, files, since }) {
  const projectAbs = resolve(projectDir)
  const memoryAbs = resolve(memoryDir)
  const sinceValue = normalizeSince(since)
  const explicit = files === undefined || files === null
    ? []
    : (Array.isArray(files) ? files : String(files).split(',')).map((f) => String(f).trim()).filter(Boolean)

  const candidates = []
  if (explicit.length > 0) {
    for (const name of explicit) {
      const full = resolve(name.startsWith('.workbuddy/') ? projectAbs : memoryAbs, name)
      const rel = normalizeRelative(projectAbs, full)
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`索引文件必须位于 project 内:${name}`)
      if (!existsSync(full) || !statSync(full).isFile()) throw new Error(`索引文件不存在:${full}`)
      if (SKIP_NAMES.has(basename(full))) throw new Error(`禁止索引敏感文件:${name}`)
      candidates.push(full)
    }
  } else {
    const selected = normalizeIndexSources(sources)
    if (selected.includes('daily')) {
      candidates.push(...listMarkdownFiles(memoryAbs)
        .filter((file) => DAILY_FILE_RE.test(basename(file))))
    }
    if (selected.includes('detail')) candidates.push(...listMarkdownFiles(join(memoryAbs, 'detail'), { detail: true }))
    if (selected.includes('rules')) candidates.push(...listMarkdownFiles(join(projectAbs, '.workbuddy', 'rules')))
  }

  const out = []
  for (const full of [...new Set(candidates.map((file) => resolve(file)))]) {
    const rel = normalizeRelative(projectAbs, full)
    const date = basename(full).match(DAILY_FILE_RE)?.[1]
    if (sinceValue && date && date < sinceValue) continue
    out.push({ full, relativePath: rel, date })
  }
  out.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  return out
}

function recordsForSource(records, sourceTag) {
  return records.filter((record) => Array.isArray(record.tags) && record.tags.includes(sourceTag))
}

function newestRecord(records) {
  return [...records].sort((a, b) =>
    (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0)
    || String(b.id).localeCompare(String(a.id)))[0]
}

function hashTagOf(record) {
  return (record.tags ?? []).find((tag) => typeof tag === 'string' && tag.startsWith('hash:'))?.slice(5)
}

/**
 * 构造索引计划（只读，不写 store）。
 * @param {{projectDir:string,memoryDir:string,sources:string[],files?:string[],since?:string,maxChars?:number,records:object[]}} options
 */
export function buildIndexPlan({
  projectDir,
  memoryDir,
  sources = DEFAULT_INDEX_SOURCES,
  files,
  since,
  maxChars = 0,
  records = [],
}) {
  const filesToIndex = resolveIndexFiles({ projectDir, memoryDir, sources, files, since })
  const plan = []
  const skippedFiles = []

  for (const file of filesToIndex) {
    const text = readFileSync(file.full, 'utf8')
    const sections = splitMarkdownSections(text)
    if (sections.length === 0) {
      skippedFiles.push({ path: file.relativePath, reason: '没有 ## 章节，拒绝整篇索引' })
      continue
    }
    for (const section of sections) {
      const body = redactSecrets(section.body)
      const prefix = file.date ? `${file.date} · ${section.heading}` : `${file.relativePath} · ${section.heading}`
      const content = limitContent(`${prefix}\n\n${body}`, maxChars)
      // hash 基于源章节，不基于脱敏后的正文；凭据变化也应触发派生索引更新。
      const hash = sha1(`${prefix}\n\n${section.body}`)
      const sourceTag = sourceTagOf(file.relativePath, section.heading)
      const candidates = recordsForSource(records, sourceTag)
      const current = newestRecord(candidates)
      const action = !current ? 'new' : hashTagOf(current) === hash ? 'skip' : 'supersede'
      plan.push({
        date: file.date,
        path: file.full,
        relativePath: file.relativePath,
        sourceKind: sourceKindOf(file.relativePath),
        heading: section.heading,
        content,
        hash,
        sourceTag,
        current,
        action,
        importance: importanceFor(section.heading, body),
      })
    }
  }
  return { plan, files: filesToIndex, skippedFiles }
}

/** @param {object[]} records */
function activeProjectIndexRecords(records) {
  const superseded = new Set(records.map((record) => record.supersedes).filter(Boolean))
  return records.filter((record) =>
    Array.isArray(record.tags)
    && record.tags.includes('project-index')
    && !superseded.has(record.id)
    && record.source?.origin === 'index')
}

/**
 * 索引新鲜度检查（只读）。
 */
export function inspectIndex({
  projectDir,
  memoryDir,
  sources = DEFAULT_STATUS_SOURCES,
  files,
  since,
  records = [],
}) {
  const built = buildIndexPlan({ projectDir, memoryDir, sources, files, since, records })
  const counts = { new: 0, supersede: 0, skip: 0 }
  for (const item of built.plan) counts[item.action]++
  const scannedPaths = new Set(built.files.map((file) => file.relativePath))
  const selectedKinds = new Set(normalizeIndexSources(sources))
  const active = activeProjectIndexRecords(records)
  const orphans = active.filter((record) => {
    const path = record.source?.path
    const kind = sourceKindOf(path)
    return kind !== null && selectedKinds.has(kind) && !scannedPaths.has(path)
  })
  const missingSources = active.filter((record) => {
    const path = record.source?.path
    if (!path) return false
    return !existsSync(join(projectDir, path))
  })
  return {
    ...built,
    counts,
    stale: counts.new + counts.supersede,
    activeIndexed: active.length,
    orphans,
    missingSources,
    latestSourceDate: [...built.files].map((file) => file.date).filter(Boolean).sort().at(-1) ?? null,
  }
}

function normalizeVectorInPlace(vec) {
  let norm = 0
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i]
  const n = Math.sqrt(norm)
  if (n > 0) for (let i = 0; i < vec.length; i++) vec[i] /= n
  return vec
}

/**
 * 执行计划：写 project scope，并在向量可用时为新增/替换记录补向量。
 * @param {{store:object,scope:string,plan:object[],vector?:object|null,noVector?:boolean}} options
 */
export async function applyIndexPlan({ store, scope, plan, vector = null, noVector = false }) {
  const counts = { new: 0, supersede: 0, skip: 0 }
  const written = []
  for (const item of plan) {
    if (item.action === 'skip') {
      counts.skip++
      if (item.current) written.push(item.current)
      continue
    }
    const { deduped, record } = store.save({
      scope,
      content: item.content,
      kind: 'note',
      tags: [
        item.sourceTag,
        `hash:${item.hash}`,
        'workbuddy',
        'project-index',
        ...(item.date ? [`date:${item.date}`] : []),
      ],
      source: {
        origin: 'index',
        path: item.relativePath,
        heading: item.heading,
        hash: item.hash,
        ...(item.date ? { date: item.date } : {}),
      },
      importance: item.importance,
      ...(item.action === 'supersede' && item.current ? { supersedes: item.current.id } : {}),
    })
    counts[deduped ? 'skip' : item.action]++
    if (record) written.push(record)
  }

  const vectors = { appended: 0, skipped: 0, failed: 0, disabled: noVector || !vector?.enabled }
  if (!vectors.disabled) {
    const sidecar = store.readSidecar(scope)
    const need = [...new Map(written.filter(Boolean).map((record) => [record.id, record])).values()]
      .filter((record) => !sidecar.vectors.has(record.id))
    if (need.length > 0) {
      const ready = await vector.ensureReady()
      if (ready === 'failed' || ready === 'disabled') {
        vectors.failed = need.length
      } else {
        if (ready === 'spawned') {
          const ok = await vector.waitUntilReady(120_000)
          if (!ok) vectors.failed = need.length
        }
        if (vectors.failed === 0) {
          const vecs = await vector.embed(need.map((record) => record.content), {
            timeoutMs: Math.max(vector.cfg?.writeTimeoutMs ?? 10_000, 30_000),
          })
          if (!vecs || vecs.length !== need.length) {
            vectors.failed = need.length
          } else {
            for (let i = 0; i < need.length; i++) {
              const appended = store.appendSidecar(scope, need[i].id, normalizeVectorInPlace(vecs[i]))
              if (appended.appended) vectors.appended++
              else vectors.failed++
            }
          }
        }
      }
    } else {
      vectors.skipped = written.length
    }
  }
  return { counts, vectors, written }
}

/**
 * dry-run 的只读 scope 读取；不构造 SharedStore（避免创建 projects/.locks）。
 * @param {string} storeDir
 * @param {string} scope
 */
export function readScopeReadOnly(storeDir, scope) {
  const file = join(storeDir, scopeFileName(scope))
  if (!existsSync(file)) return []
  const records = []
  let lineNo = 0
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    lineNo++
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const record = JSON.parse(trimmed)
      if (!record || typeof record.id !== 'string' || typeof record.content !== 'string' || record.scope !== scope) {
        throw new Error('bad shape')
      }
      records.push(record)
    } catch {
      console.warn(`[warn] 跳过坏行 ${file}:${lineNo}`)
    }
  }
  return records
}
