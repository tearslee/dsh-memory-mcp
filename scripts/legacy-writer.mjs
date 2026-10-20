/**
 * 复刻上游 MemoryStore 写路径的最小写者（故意不加锁）。
 *
 * 只为共存验收服务：让「无锁 + 内存快照 + 全量重写」这条路径真实跑一次，
 * 用来量化它与加锁写者并存时的数据丢失。**不要在生产里用这个文件。**
 *
 * 用法：node legacy-writer.mjs <storeRoot> <scope> <count>
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

const [root, scope, countRaw] = process.argv.slice(2)
const count = Number.parseInt(countRaw ?? '10', 10)

function fileFor(scopeKey) {
  if (scopeKey === 'global') return join(root, 'global.jsonl')
  const hash = createHash('sha1').update(scopeKey).digest('hex')
  return join(root, 'projects', `${hash}.jsonl`)
}

function normalizeContent(content) {
  return content.replace(/\s+/g, ' ').trim().toLowerCase()
}
function contentHash(scopeKey, content) {
  return createHash('sha1').update(`${scopeKey}::${normalizeContent(content)}`).digest('hex')
}

// 上游语义：进程启动时把整个文件读进内存，此后只认这份快照。
const file = fileFor(scope)
const records = new Map()
if (existsSync(file)) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const rec = JSON.parse(t)
      if (rec && typeof rec.id === 'string') records.set(rec.id, rec)
    } catch {
      /* skip */
    }
  }
}
console.error(`[legacy] 启动时读到 ${records.size} 条`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

for (let i = 0; i < count; i++) {
  const content = `上游式写者-${i}-${Date.now().toString(36)} 记录`
  const now = Date.now()
  let deduped = false
  const hash = contentHash(scope, content)
  for (const rec of records.values()) {
    if (contentHash(rec.scope, content) === hash) {
      rec.updatedAt = now
      deduped = true
      break
    }
  }
  if (!deduped) {
    records.set(randomUUID(), {
      id: randomUUID(),
      scope,
      kind: 'note',
      content,
      tags: [],
      source: { origin: 'legacy-writer' },
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      importance: 0.5,
    })
  }
  // 上游 flush：拿内存快照全量重写（tmp + rename）
  const lines = [...records.values()].map((r) => JSON.stringify(r))
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, lines.length ? `${lines.join('\n')}\n` : '', 'utf8')
  renameSync(tmp, file)
  await sleep(15)
}

console.error(`[legacy] 写完 ${count} 条，内存中 ${records.size} 条`)