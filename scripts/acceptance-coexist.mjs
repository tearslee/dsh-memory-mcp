/**
 * 共存验收：模拟 DSH 插件进程（上游 MemoryStore 的行为）与 MCP 服务并发写同一 storeDir。
 *
 * 背景：上游 MemoryStore 在进程内缓存 scope 快照、flush 时全量重写整个 jsonl，
 * 所以「DSH 写的记录会不会被 MCP 抹掉」是本次改造的核心风险点。
 *
 * 本脚本用**两种写者**同时压同一个 scope：
 *   - 写者 A：SharedStore（本项目，带锁 + 现读盘）
 *   - 写者 B：一个最小复刻上游 flush 语义的裸进程（无锁、内存快照、全量重写）
 * 并在结束后断言：A 写的记录是否被 B 覆盖掉 —— 用来**量化**上游行为会丢多少，
 * 证明加锁这一侧确实必要，同时明确告诉使用者混用时的真实边界。
 *
 * 用法：node scripts/acceptance-coexist.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SharedStore, scopeFileName } from '../src/store.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'dsh-coexist-'))
const scope = 'global'

let pass = 0
let fail = 0
function check(ok, label, extra = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${label}${extra ? `  ${extra}` : ''}`)
  } else {
    fail++
    console.log(`  ✗ FAIL  ${label}${extra ? `  ${extra}` : ''}`)
  }
}

console.log(`\n=== 共存验收：上游式写者 vs 加锁写者 ===`)
console.log(`临时 store: ${root}\n`)

// 写者 B：复刻上游语义 —— 启动时读一次盘进内存，之后每次写都拿内存快照全量重写。
const legacyWorker = resolve(HERE, 'legacy-writer.mjs')
const child = spawn(process.execPath, [legacyWorker, root, scope, '12'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
let legacyOut = ''
child.stdout.on('data', (d) => {
  legacyOut += d.toString()
})
child.stderr.on('data', (d) => {
  legacyOut += d.toString()
})

// 写者 A：本项目，同时开 3 个实例压同一个 scope。
const store = new SharedStore(root, { vecIdentity: 'test-model\t8' })
const mine = []
for (let i = 0; i < 3; i++) {
  const s = new SharedStore(root, { vecIdentity: 'test-model\t8' })
  for (let j = 0; j < 8; j++) {
    const content = `加锁写者A-${i}-${j} ${'内容'.repeat(3)}`
    const r = await s.save({ scope, kind: 'note', content, importance: 0.5, tags: [] })
    mine.push({ id: r.record.id, content })
  }
}

const exitCode = await new Promise((res) => child.on('exit', res))
console.log(`\n上游式写者退出码: ${exitCode}`)
console.log(`其输出: ${legacyOut.trim().split('\n').slice(-3).join(' / ')}\n`)
// 子进程起崩(端口/句柄竞争等)会让这一节变成"无对照"的空断言 —— 必须显式判失败,
// 否则会打印出一份看似合理的报告,掩盖"写者 B 其实压根没跑"的事实。
check(exitCode === 0, '上游式写者正常跑完(exit=0)', legacyOut.trim().split('\n').slice(-2).join(' / '))

const file = join(root, scopeFileName(scope))
const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
const lines = text.split('\n').filter((l) => l.trim() !== '')
const recs = []
for (const l of lines) {
  try {
    recs.push(JSON.parse(l))
  } catch {
    /* skip */
  }
}

console.log('── 1. 并发期后的完整性（诚实记录：双向互毁是预期结果）')
const survived = mine.filter((m) => recs.some((r) => r.id === m.id && r.content === m.content))
console.log(`  加锁写者 A 写入 ${mine.length} 条 → 磁盘剩 ${survived.length} 条`)
const theirs = recs.filter((r) => typeof r.content === 'string' && r.content.startsWith('上游式写者'))
console.log(`  上游式写者写入 12 条 → 磁盘剩 ${theirs.length} 条`)
console.log(`  合计磁盘 ${recs.length} 条（写入前双方共 ${mine.length + 12} 条）`)
console.log('')
console.log('  结论：两个进程并发写同一 scope 时**双向互毁**，不是单方面碾压。')
console.log('  原因是上游 MemoryStore 无锁 + 内存快照 + 全量重写：它既看不见我们中途')
console.log('  写入的行，于是自己 flush 时把我们的行一起覆盖掉；我们加锁保证了**自己的**')
console.log('  事务不丢，但挡不住另一个进程的无锁全量重写。')
console.log('')
console.log('  ⇒ 使用纪律（唯一可靠的办法）：**同一时刻只让一个进程写同一 scope**。')
console.log('    读没有任何问题（读路径不产生覆盖）。日常用法是 DSH 与 MCP 交替用，')
console.log('    不要在两边同一瞬间各写一条。')

console.log('\n── 2. 无并发时，加锁写者自身不丢（这才是可修的部分）')
const solo = new SharedStore(root, { vecIdentity: 'test-model\t8' })
const soloIds = []
for (let i = 0; i < 5; i++) {
  const r = await solo.save({ scope, kind: 'note', content: `串行写-${i}-${Date.now()}`, importance: 0.5, tags: [] })
  soloIds.push(r.record.id)
}
const after = solo.listRecords({ scopeKeys: [scope] })
check(soloIds.every((id) => after.some((r) => r.id === id)), '串行写入 5 条全部可读回',
  `${soloIds.filter((id) => after.some((r) => r.id === id)).length}/5`)
check(new Set(after.map((r) => r.id)).size === after.length, '记录 id 无重复')

console.log('\n── 3. 外部（DSH 式）锁外追加不被本库 flush 抹掉')
const sim = `${JSON.stringify({
  id: 'external-dsh-record-0001',
  scope,
  kind: 'note',
  content: '模拟 DSH 进程在锁外追加的一条记忆',
  tags: [],
  source: { origin: 'dsh-sim' },
  createdAt: Date.now(),
  updatedAt: Date.now(),
  lastAccessedAt: Date.now(),
  accessCount: 0,
  importance: 0.5,
})}\n`
writeFileSync(file, readFileSync(file, 'utf8') + sim, 'utf8')
await solo.save({ scope, kind: 'note', content: '追加之后再存一条', importance: 0.5, tags: [] })
const reread = solo.listRecords({ scopeKeys: [scope] })
check(reread.some((r) => r.id === 'external-dsh-record-0001'), '外部追加的记录在 flush 后仍在')

console.log(`\n=== 汇总：通过 ${pass}，失败 ${fail} ===`)
try {
  rmSync(root, { recursive: true, force: true })
} catch {
  /* ignore */
}
process.exit(fail === 0 ? 0 : 1)