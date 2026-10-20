#!/usr/bin/env node
/**
 * 跨进程安全自测。
 *
 * # 红线:绝不能碰真实的 store 目录
 *
 * 所有用例都在 `os.tmpdir()` 下的随机临时目录里跑。脚本开头有硬断言:
 * 一旦 `D:/dev/.dsh-memory-store` 出现在任何测试路径里,直接退出而不是"小心地跑"。
 * 真实目录里是 DSH 插件正在用的数据(有已算好的向量),被自测改写是不可逆的。
 *
 * # 并发是真的并发
 *
 * 关键用例**真的 fork 子进程**:父进程 spawn 4 个 `node selftest.mjs --worker ...`,
 * 4 个进程同时对**同一个 scope** 各写 20 条。单进程循环是模拟不出这个 bug 的 ——
 * 上游 `MemoryStore` 的丢失恰恰只在两个地址空间同时存在时才发生。
 *
 * 子进程复用**本文件自身**(而非另建 worker 文件),这样父子跑的是同一份 store 代码,
 * 不会出现"自测通过但真实调用走另一条路径"的情况。
 */
import { spawn } from 'node:child_process'
import {
  appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SharedStore, scopeFileName, contentHash, normalizeContent, firstScopeInFile } from '../src/store.js'
import { withLock, lockPathFor, pidAlive } from '../src/lock.js'
import { ScopeNames, createScopeNames } from '../src/scope-names.js'
import { tokenize, lexicalScore, buildStats, normalizeInPlace, cosine } from '../src/scoring.js'
import { normalizeScopeInput, scopeKind, scopeTier, isCustomScope } from '../src/scope.js'

const SELF = fileURLToPath(import.meta.url)
const REAL_STORE = 'D:\\dev\\.dsh-memory-store'
const KEEP = process.argv.includes('--keep')

// ------------------------------------------------------------------ 极简测试框架

let passed = 0
const failures = []
let currentSection = ''

function section(title) {
  currentSection = title
  process.stdout.write(`\n\x1b[1m── ${title}\x1b[0m\n`)
}

async function test(name, fn) {
  try {
    await fn()
    passed++
    process.stdout.write(`  \x1b[32m✓\x1b[0m ${name}\n`)
  } catch (err) {
    failures.push({ section: currentSection, name, err })
    process.stdout.write(`  \x1b[31m✗\x1b[0m ${name}\n      \x1b[31m${err?.message ?? err}\x1b[0m\n`)
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: 期望 ${JSON.stringify(expected)},实际 ${JSON.stringify(actual)}`)
  }
}

/** 临时目录 + 红线守卫:任何指向真实 store 目录的路径都必须直接中止。 */
function assertNotRealStore(p) {
  const norm = p.replace(/\//g, '\\').toLowerCase()
  assert(!norm.startsWith(REAL_STORE.toLowerCase()), `自测拒绝触碰真实 store 目录: ${p}`)
  assert(!norm.includes('\\dev\\.dsh-memory-store'), `自测拒绝触碰真实 store 目录: ${p}`)
}

/** 所有本进程创建的临时目录,退出时统一清理(--keep 可保留)。 */
const tempRoots = []

function newTempRoot(tag) {
  const root = mkdtempSync(join(tmpdir(), `dsh-store-${tag}-`))
  assertNotRealStore(root)
  tempRoots.push(root)
  return root
}

// ------------------------------------------------------------------ 子进程 worker

/** 把一个子进程跑完,返回 { code, stdout, stderr }。 */
function runWorker(task, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SELF, '--worker', JSON.stringify(task)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`worker 超时 ${timeoutMs}ms`))
    }, timeoutMs)
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

/** 并发启动 N 个 worker,等它们全部结束,返回各自结果(顺序与 tasks 对应)。 */
async function runWorkersConcurrently(tasks) {
  const results = await Promise.all(tasks.map((task) => runWorker(task)))
  for (const [i, r] of results.entries()) {
    if (r.code !== 0) {
      throw new Error(`worker#${i} 退出码 ${r.code}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`)
    }
  }
  return results
}

async function workerMain(task) {
  switch (task.op) {
    case 'bulk-save': {
      // 每个子进程独占一个 SharedStore 实例(与真实部署一致:每进程一个 store 对象)。
      const store = new SharedStore(task.root)
      for (let i = 0; i < task.count; i++) {
        store.save({
          scope: task.scope,
          kind: 'procedure',
          content: `${task.prefix}-${i} 并发写入的记录内容`,
          tags: [`proc-${task.index}`],
          importance: 0.7,
          source: { origin: 'explicit' },
        })
      }
      return { saved: task.count }
    }
    case 'bulk-append-vec': {
      const store = new SharedStore(task.root, { vecIdentity: task.identity })
      const dims = task.dims
      for (let i = 0; i < task.count; i++) {
        const vec = new Float32Array(dims)
        vec.fill(0)
        // 每个 (进程, 序号) 一个确定性的非零维度,便于断言各进程的行互不相同。
        vec[i % dims] = task.index + 1
        const res = store.appendSidecar(task.scope, `${task.prefix}-${i}`, vec)
        if (!res.appended) throw new Error(`appendSidecar 失败: ${res.reason}`)
      }
      return { appended: task.count }
    }
    case 'hold-lock': {
      // 持有锁 ms 毫秒,用于验证"别人拿不到锁会超时而不是死等"。
      const got = withLock(task.scope, () => {
        const until = Date.now() + task.ms
        while (Date.now() < until) { /* 忙等:锁是同步的,这里故意占住不放 */ }
        return true
      }, { root: task.root })
      return { held: got }
    }
    case 'claim-name': {
      const names = createScopeNames(task.root)
      try {
        const claimed = names.claim(task.scope, task.name)
        return { ok: true, claimed }
      } catch (err) {
        return { ok: false, code: err?.code, message: err?.message }
      }
    }
    default:
      throw new Error(`未知 worker op: ${task.op}`)
  }
}

// ------------------------------------------------------------------ 用例

async function run() {
  // ============ 0. 目录与红线 ============
  section('0. 环境与红线守卫')

  const rootA = newTempRoot('conc')
  process.stdout.write(`  临时目录: ${rootA}\n`)
  await test('临时目录不在真实 store 目录内', () => {
    assertNotRealStore(rootA)
    assert(existsSync(rootA), '临时目录应已创建')
  })
  await test('红线守卫会拒绝真实 store 路径', () => {
    let threw = false
    try {
      assertNotRealStore('D:\\dev\\.dsh-memory-store\\global.jsonl')
    } catch {
      threw = true
    }
    assert(threw, '守卫必须对真实 store 路径抛错')
  })

  // ============ 1. 单进程基本语义(与上游格式兼容) ============
  section('1. 单进程存储语义')

  const rootB = newTempRoot('basic')
  const storeB = new SharedStore(rootB)
  const SCOPE = 'project:D:/dev/example-workspace'

  await test('save 落盘后能读回来,字段与上游形状一致', () => {
    const { deduped, record } = storeB.save({
      scope: SCOPE,
      kind: 'procedure',
      content: '提交前必须先跑一遍自测',
      tags: ['git', 'test'],
      importance: 0.8,
      source: { origin: 'explicit' },
    })
    assertEqual(deduped, false, '首次写入不应判为去重')
    for (const field of ['id', 'scope', 'kind', 'content', 'tags', 'source', 'createdAt', 'updatedAt', 'lastAccessedAt', 'accessCount', 'importance']) {
      assert(record[field] !== undefined, `记录缺少字段 ${field}`)
    }
    assert(Array.isArray(record.tags), 'tags 必须是数组')
    assertEqual(record.scope, SCOPE, 'scope 必须原样保存')
  })

  await test('文件路径映射与上游一致(global.jsonl / projects/<sha1>.jsonl)', () => {
    assertEqual(scopeFileName('global'), 'global.jsonl', 'global 文件名')
    // `scopeFileName()` 用 `join()` 产出**平台分隔符**(Windows `\`,POSIX `/`)。
    // 这里不能写字面量 `projects\\...`:在 Linux/macOS 上 `\` 是普通文件名字符,
    // 断言会因为分隔符而不是逻辑挂掉(CI 的 ubuntu 矩阵就是靠这条暴露出来的)。
    const expected = join('projects', `${createHash('sha1').update(SCOPE).digest('hex')}.jsonl`)
    assertEqual(scopeFileName(SCOPE), expected, 'project scope 文件名')
    assert(existsSync(join(rootB, scopeFileName(SCOPE))), '数据文件应真实存在')
  })

  await test('幂等去重:同 scope 同内容 → deduped,记录数不变', () => {
    const before = storeB.readScope(SCOPE).size
    const r = storeB.save({ scope: SCOPE, kind: 'procedure', content: '提交前必须先跑一遍自测' })
    assertEqual(r.deduped, true, '重复内容应判为去重')
    assertEqual(storeB.readScope(SCOPE).size, before, '去重不得增加记录数')
  })

  await test('去重会刷新 updatedAt / accessCount / importance 取 max', () => {
    const r = storeB.save({ scope: SCOPE, kind: 'procedure', content: '提交前必须先跑一遍自测', importance: 0.95 })
    assertEqual(r.deduped, true, '应命中去重')
    assertEqual(r.record.importance, 0.95, 'importance 应取 max')
    assert(r.record.accessCount >= 1, 'accessCount 应被刷新')
  })

  await test('不同 scope 的相同内容互不去重(去重键含 scope)', () => {
    const content = '这条内容在两个 scope 里各有一份'
    storeB.save({ scope: 'global', kind: 'fact', content })
    storeB.save({ scope: SCOPE, kind: 'fact', content })
    assert(contentHash('global', content) !== contentHash(SCOPE, content), '含 scope 的哈希应不同')
    assert(storeB.hasContent('global', content), 'global 应有该内容')
    assert(storeB.hasContent(SCOPE, content), 'project 应有该内容')
  })

  await test('allScopeKeys 从哈希文件名还原 scope 键', () => {
    const keys = storeB.allScopeKeys()
    assert(keys.includes('global'), '应还原出 global')
    assert(keys.includes(SCOPE), '应还原出 project scope')
  })

  await test('firstScopeInFile 能从内容读回 scope', () => {
    assertEqual(firstScopeInFile(join(rootB, scopeFileName(SCOPE))), SCOPE, '首条记录的 scope')
  })

  await test('listRecords 按 updatedAt 降序', () => {
    for (const n of [1, 2, 3]) storeB.save({ scope: SCOPE, kind: 'note', content: `排序测试 ${n}` })
    const list = storeB.listRecords({ scopeKeys: [SCOPE] })
    for (let i = 1; i < list.length; i++) {
      assert(list[i - 1].updatedAt >= list[i].updatedAt, '必须按 updatedAt 降序')
    }
  })

  await test('listRecords 支持 kind 过滤与 limit', () => {
    storeB.save({ scope: SCOPE, kind: 'preference', content: '唯一的 preference 记录' })
    const pref = storeB.listRecords({ scopeKeys: [SCOPE], kind: 'preference' })
    assert(pref.every((r) => r.kind === 'preference'), 'kind 过滤应生效')
    assertEqual(storeB.listRecords({ scopeKeys: [SCOPE], limit: 2 }).length, 2, 'limit 应生效')
  })

  await test('listRecords 省略 scopeKeys 时返回所有作用域', () => {
    const all = storeB.listRecords({})
    const scopes = new Set(all.map((r) => r.scope))
    assert(scopes.size >= 2, `省略 scopeKeys 应跨所有 scope,实际只看到 ${[...scopes].join(',')}`)
  })

  await test('normalizeContent 与上游一致(折叠空白 + 小写)', () => {
    assertEqual(normalizeContent('  Hello   \n World  '), 'hello world', '空白折叠')
  })

  // ============ 2. 并发写(验收核心) ============
  section('2. 跨进程并发写(4 进程 × 20 条 = 80 条)')

  const PROCS = 4
  const PER_PROC = 20
  const EXPECTED_TOTAL = PROCS * PER_PROC

  const tasks = Array.from({ length: PROCS }, (_, i) => ({
    op: 'bulk-save',
    root: rootA,
    scope: SCOPE,
    prefix: `p${i}`,
    count: PER_PROC,
    index: i,
  }))

  const t0 = Date.now()
  const workerResults = await runWorkersConcurrently(tasks)
  const elapsed = Date.now() - t0

  let sawConcurrency = false
  await test(`4 个真实子进程各写 ${PER_PROC} 条,全部成功退出`, () => {
    for (const [i, r] of workerResults.entries()) {
      assertEqual(r.code, 0, `worker#${i} 退出码`)
      const parsed = JSON.parse(r.stdout.trim().split('\n').pop())
      assertEqual(parsed.saved, PER_PROC, `worker#${i} 写入条数`)
    }
    process.stdout.write(`      耗时 ${elapsed}ms,平均每次事务 ${(elapsed / EXPECTED_TOTAL).toFixed(1)}ms\n`)
  })

  await test(`磁盘上恰好有 ${EXPECTED_TOTAL} 条记录(无丢失、无覆盖)`, () => {
    const file = join(rootA, scopeFileName(SCOPE))
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
    assertEqual(lines.length, EXPECTED_TOTAL, 'JSONL 行数')
    const ids = new Set()
    for (const [i, line] of lines.entries()) {
      const rec = JSON.parse(line) // 任意一行解析失败 = 文件被写坏
      assert(typeof rec.id === 'string' && rec.id, `第 ${i + 1} 行缺 id`)
      assert(!ids.has(rec.id), `id 重复: ${rec.id}`)
      ids.add(rec.id)
    }
    assertEqual(ids.size, EXPECTED_TOTAL, 'id 必须唯一')
  })

  await test('80 条记录的 content 全部正确、无一条被别的进程覆盖', () => {
    const records = new SharedStore(rootA).readScope(SCOPE)
    assertEqual(records.size, EXPECTED_TOTAL, '读回的记录数')
    const expected = new Set()
    for (let p = 0; p < PROCS; p++) for (let i = 0; i < PER_PROC; i++) expected.add(`p${p}-${i} 并发写入的记录内容`)
    const actual = new Set([...records.values()].map((r) => r.content))
    const missing = [...expected].filter((c) => !actual.has(c))
    assertEqual(missing.length, 0, `丢失 ${missing.length} 条内容,例如: ${missing.slice(0, 5).join(' | ')}`)
    for (const rec of records.values()) {
      assertEqual(rec.scope, SCOPE, '每条记录的 scope 字段都应正确')
      assert(rec.tags?.[0]?.startsWith('proc-'), 'tag 应来自写入它的那个进程')
    }
  })

  await test('每个进程的 20 条都在(不是"某个进程全赢、另一个全丢")', () => {
    const records = new SharedStore(rootA).readScope(SCOPE)
    for (let p = 0; p < PROCS; p++) {
      const n = [...records.values()].filter((r) => r.content.startsWith(`p${p}-`)).length
      assertEqual(n, PER_PROC, `进程 p${p} 的记录数`)
    }
  })

  await test('无残留 .tmp 文件(原子写的临时文件都被 rename 或清理了)', () => {
    const projDir = join(rootA, 'projects')
    for (const f of readdirSync(projDir)) {
      assert(!f.endsWith('.tmp'), `残留 tmp 文件: ${f}`)
    }
  })

  await test('锁文件在全部 worker 退出后已释放', async () => {
    const lockFile = lockPathFor(rootA, SCOPE)
    assert(!existsSync(lockFile), `锁文件应已释放,仍存在: ${lockFile}`)
  })

  // ============ 3. 外部进程追加不被覆盖(核心回归) ============
  section('3. 外部进程追加行不被本库 flush 抹掉')

  const rootC = newTempRoot('external')
  const storeC = new SharedStore(rootC)
  const SCOPE_C = 'project:D:/dev/external-writer'
  const fileC = join(rootC, scopeFileName(SCOPE_C))

  await test('模拟 DSH 进程直接追加 3 行到 JSONL', () => {
    storeC.save({ scope: SCOPE_C, kind: 'fact', content: '本库写的第一条' })
    const now = Date.now()
    const external = [
      { id: 'ext-1', scope: SCOPE_C, kind: 'fact', content: 'DSH 进程追加的 A', tags: [], source: { origin: 'explicit' }, createdAt: now, updatedAt: now, lastAccessedAt: now, accessCount: 0, importance: 0.8 },
      { id: 'ext-2', scope: SCOPE_C, kind: 'fact', content: 'DSH 进程追加的 B', tags: [], source: { origin: 'explicit' }, createdAt: now, updatedAt: now, lastAccessedAt: now, accessCount: 0, importance: 0.8 },
      { id: 'ext-3', scope: SCOPE_C, kind: 'fact', content: 'DSH 进程追加的 C', tags: [], source: { origin: 'explicit' }, createdAt: now, updatedAt: now, lastAccessedAt: now, accessCount: 0, importance: 0.8 },
    ]
    // 真实 DSH 走的是 appendFileSync(appendVector 之外的路径),这里如实模拟。
    appendFileSync(fileC, external.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    assertEqual(readFileSync(fileC, 'utf8').split('\n').filter((l) => l.trim()).length, 4, '追加后应为 4 行')
  })

  await test('本库 save() 之后,外部追加的 3 条仍在(这就是上游会丢的那部分)', () => {
    storeC.save({ scope: SCOPE_C, kind: 'fact', content: '本库后写的第二条' })
    const ids = new Set([...storeC.readScope(SCOPE_C).keys()])
    for (const id of ['ext-1', 'ext-2', 'ext-3']) {
      assert(ids.has(id), `外部写入的 ${id} 被本库 save 覆盖抹掉了 —— 这正是要修的 bug`)
    }
    assertEqual(storeC.readScope(SCOPE_C).size, 5, '总数应为 5')
  })

  await test('连续多次 save,外部写入始终不丢', () => {
    for (let i = 0; i < 10; i++) {
      storeC.save({ scope: SCOPE_C, kind: 'note', content: `本库反复写 ${i}` })
    }
    const ids = new Set([...storeC.readScope(SCOPE_C).keys()])
    assert(ids.has('ext-1') && ids.has('ext-2') && ids.has('ext-3'), '多轮写后外部记录仍在')
  })

  await test('外部进程在锁外疯狂追加的同时本库反复写,双方都不丢', async () => {
    const rootD = newTempRoot('mixed')
    const storeD = new SharedStore(rootD)
    const scopeD = 'project:D:/dev/mixed'
    storeD.save({ scope: scopeD, kind: 'fact', content: '起点' })
    const fileD = join(rootD, scopeFileName(scopeD))

    // 一个"DSH"进程在锁外持续 append(上游的 append 语义),
    // 同时本库在锁内反复全量写回。两边都不能把对方的数据弄丢。
    let stop = false
    const external = (async () => {
      const now = Date.now()
      let i = 0
      while (!stop) {
        const rec = { id: `ext-mixed-${i}`, scope: scopeD, kind: 'fact', content: `外部 ${i}`, tags: [], source: { origin: 'explicit' }, createdAt: now, updatedAt: now, lastAccessedAt: now, accessCount: 0, importance: 0.8 }
        appendFileSync(fileD, `${JSON.stringify(rec)}\n`, 'utf8')
        i++
        await new Promise((r) => setImmediate(r))
      }
      return i
    })()
    for (let i = 0; i < 15; i++) storeD.save({ scope: scopeD, kind: 'note', content: `本库写 ${i}` })
    stop = true
    const written = await external
    const records = storeD.readScope(scopeD)
    assertEqual(records.size, 16 + written, `本库 16 条 + 外部 ${written} 条都应在`)
  })

  // ============ 4. 锁 ============
  section('4. 跨进程锁')

  const rootE = newTempRoot('lock')
  const storeE = new SharedStore(rootE)
  const SCOPE_E = 'project:D:/dev/lock-test'

  await test('锁文件路径为 <root>/.locks/<sha1>.lock', () => {
    const p = lockPathFor(rootE, SCOPE_E)
    assert(p.includes('.locks'), '锁应在 .locks 目录下')
    assert(p.endsWith(`${createHash('sha1').update(SCOPE_E).digest('hex')}.lock`), '锁文件名应为 sha1')
  })

  await test('withLock 正常获取与释放,回调返回值透出', () => {
    const r = withLock(SCOPE_E, () => 42, { root: rootE })
    assertEqual(r, 42, '返回值')
    assert(!existsSync(lockPathFor(rootE, SCOPE_E)), '释放后不应残留锁文件')
  })

  await test('回调抛错时锁仍然被释放', () => {
    let threw = false
    try {
      withLock(SCOPE_E, () => { throw new Error('业务异常') }, { root: rootE })
    } catch {
      threw = true
    }
    assert(threw, '异常应向外抛')
    assert(!existsSync(lockPathFor(rootE, SCOPE_E)), '异常路径必须释放锁')
  })

  await test('同进程递归加锁被立即拒绝(而不是 10 秒后超时死等)', () => {
    let code = null
    withLock(SCOPE_E, () => {
      try {
        withLock(SCOPE_E, () => {}, { root: rootE })
      } catch (err) {
        code = err?.code
      }
    }, { root: rootE })
    assertEqual(code, 'LOCK_RECURSION', '应报递归加锁')
  })

  await test('别的进程持锁时,本进程超时抛错而不是无限等待', async () => {
    const holder = runWorker({ op: 'hold-lock', root: rootE, scope: SCOPE_E, ms: 2500 })
    await new Promise((r) => setTimeout(r, 400)) // 等它真的拿到锁
    const t = Date.now()
    let code = null
    try {
      withLock(SCOPE_E, () => {}, { root: rootE, timeoutMs: 600 })
    } catch (err) {
      code = err?.code
    }
    const waited = Date.now() - t
    assertEqual(code, 'LOCK_TIMEOUT', '应抛 LOCK_TIMEOUT')
    assert(waited >= 550 && waited < 2000, `应在超时附近返回,实际等了 ${waited}ms`)
    await holder
    assert(!existsSync(lockPathFor(rootE, SCOPE_E)), '持锁进程退出后锁应释放')
  })

  await test('陈旧锁(死进程 + 旧时间戳)会被接管', () => {
    const scope = 'project:D:/dev/stale'
    const lockFile = lockPathFor(rootE, scope)
    // 用一个确定已退出的 pid 伪造崩溃残留
    const dead = { pid: 0x7ffffffe, hostname: hostname(), acquiredAt: Date.now() - 60_000 }
    writeFileSync(lockFile, `${JSON.stringify(dead)}\n`, 'utf8')
    const t = Date.now()
    const r = withLock(scope, () => '接管成功', { root: rootE, timeoutMs: 2000 })
    assertEqual(r, '接管成功', '应能接管陈旧锁')
    assert(Date.now() - t < 1500, '接管必须很快,不能靠等超时')
    assert(!existsSync(lockFile), '接管后应释放')
  })

  await test('内容为半截 JSON 的锁(创建时崩溃)按 mtime 判龄后被接管', () => {
    const scope = 'project:D:/dev/halfwritten'
    const lockFile = lockPathFor(rootE, scope)
    writeFileSync(lockFile, '{"pid":', 'utf8') // 写到一半就崩溃
    const r = withLock(scope, () => 'ok', { root: rootE, staleMs: 50, timeoutMs: 2000 })
    assertEqual(r, 'ok', '半截锁应可被接管')
  })

  await test('锁粒度是单 scope:不同 scope 可并发,同一 scope 串行', async () => {
    const s1 = 'project:D:/dev/grain-1'
    const s2 = 'project:D:/dev/grain-2'
    const order = []
    const p1 = withLock(s1, () => { order.push('s1'); return 1 }, { root: rootE })
    const p2 = withLock(s2, () => { order.push('s2'); return 2 }, { root: rootE })
    assertEqual(p1, 1, 's1')
    assertEqual(p2, 2, 's2')
    assertEqual(order.length, 2, '两个 scope 都应能拿到锁')
    assert(!existsSync(lockPathFor(rootE, s1)), 's1 锁已释放')
    assert(!existsSync(lockPathFor(rootE, s2)), 's2 锁已释放')
  })

  await test('pidAlive 对已退出进程返回 false、对自身返回 true', () => {
    assertEqual(pidAlive(process.pid), true, '自身存活')
    assertEqual(pidAlive(0x7ffffffe), false, '不存在的 pid')
    assertEqual(pidAlive(-1), false, '非法 pid')
  })

  // ============ 5. .vec 向量边车 ============
  section('5. .vec 向量边车')

  const rootF = newTempRoot('vec')
  const IDENTITY = 'qwen3-embedding-0.6b\t1024'
  const storeF = new SharedStore(rootF, { vecIdentity: IDENTITY })
  const SCOPE_F = 'project:D:/dev/vec-test'
  const DIMS = 8

  await test('首次 append 会先写 #identity 头,再写数据行', () => {
    const rec = storeF.save({ scope: SCOPE_F, kind: 'fact', content: '需要向量的一条记录' })
    const v = new Float32Array(DIMS)
    v.fill(0.1)
    const res = storeF.appendSidecar(SCOPE_F, rec.record.id, v)
    assert(res.appended, `append 应成功: ${res.reason}`)
    const lines = readFileSync(storeF.vecFileFor(SCOPE_F), 'utf8').split('\n').filter((l) => l.trim())
    assertEqual(lines.length, 2, '应为 1 个头 + 1 行数据')
    assertEqual(lines[0], `#${IDENTITY}`, '头必须是 #<model>\\t<dims>')
    assert(lines[1].startsWith(`${rec.record.id}\t`), '数据行必须是 <id>\\t<base64>')
  })

  await test('readSidecar 返回 model / dims / vectors', () => {
    const side = storeF.readSidecar(SCOPE_F)
    assertEqual(side.identity, IDENTITY, 'identity')
    assertEqual(side.model, 'qwen3-embedding-0.6b', 'model 应从 identity 解析')
    assertEqual(side.dims, 1024, 'dims 应从 identity 解析')
    assertEqual(side.vectors.size, 1, '应有 1 个向量')
    assert(side.vectors.values().next().value instanceof Float32Array, '向量应为 Float32Array')
  })

  await test('base64 编码与上游逐字节一致(Float32Array 原始字节)', () => {
    const v = new Float32Array([1, -2, 3.5, 0])
    const bytes = Buffer.from(v.buffer, v.byteOffset, v.byteLength)
    assertEqual(bytes.length, 16, '4 字节/浮点 × 4 个')
    // 编码路径与上游 encodeVec 完全相同;这里断言的是**往返保真**——
    // 真正的兼容要求是"DSH 写的能被本库原样读出来,反之亦然"。
    assertEqual(bytes.toString('hex'), '0000803f000000c00000604000000000', 'IEEE-754 原始字节')
    assertEqual(bytes.toString('base64'), 'AACAPwAAAMAAAGBAAAAAAA==', 'base64 结果')
    const back = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length))
    assertEqual(JSON.stringify([...back]), JSON.stringify([1, -2, 3.5, 0]), '解码必须无损往返')
  })

  await test('头不匹配时整个边车被丢弃,并标记 discarded', () => {
    const side = storeF.readSidecar(SCOPE_F) // 先自证本身是一致的
    assertEqual(side.discarded, false, '同 identity 不应丢弃')
    const other = new SharedStore(rootF, { vecIdentity: 'bge-m3\t1024' })
    const side2 = other.readSidecar(SCOPE_F)
    assertEqual(side2.discarded, true, '换模型应整体丢弃')
    assertEqual(side2.vectors.size, 0, '丢弃后向量为空')
    assertEqual(side2.identity, IDENTITY, '仍回传盘上实际身份,供调用方判别')
  })

  await test('身份不匹配时 appendSidecar 拒绝写入(不覆盖别人的向量)', () => {
    const other = new SharedStore(rootF, { vecIdentity: 'bge-m3\t1024' })
    const before = readFileSync(storeF.vecFileFor(SCOPE_F), 'utf8')
    const res = other.appendSidecar(SCOPE_F, 'some-id', new Float32Array(DIMS))
    assertEqual(res.appended, false, '应拒绝写入')
    assert(res.reason.includes('identity mismatch'), `理由应说明身份不匹配,实际: ${res.reason}`)
    assertEqual(readFileSync(storeF.vecFileFor(SCOPE_F), 'utf8'), before, '文件不得被改动')
  })

  await test('无身份的旧格式边车不会被补头(避免替别人的数据声明身份)', () => {
    const rootG = newTempRoot('legacy')
    const storeG = new SharedStore(rootG, { vecIdentity: IDENTITY })
    const rec = storeG.save({ scope: SCOPE_F, kind: 'fact', content: '旧格式边车' })
    const vecFile = storeG.vecFileFor(SCOPE_F)
    appendFileSync(vecFile, `${rec.record.id}\tAAAA\n`, 'utf8') // 无头
    const res = storeG.appendSidecar(SCOPE_F, 'new-id', new Float32Array(DIMS))
    assertEqual(res.appended, false, '旧格式边车应拒绝追加')
    assert(res.reason.includes('legacy'), `理由应指出旧格式,实际: ${res.reason}`)
  })

  await test('4 进程并发 append 向量,80 行全在(append 语义不互相覆盖)', async () => {
    const rootH = newTempRoot('vecconc')
    const storeH = new SharedStore(rootH, { vecIdentity: IDENTITY })
    const scopeH = 'project:D:/dev/vec-conc'
    const scopeFile = join(rootH, scopeFileName(scopeH))
    writeFileSync(scopeFile, '', 'utf8') // 空文件也算"已发现"的 scope
    const ids = []
    for (let p = 0; p < PROCS; p++) for (let i = 0; i < PER_PROC; i++) ids.push(`p${p}-${i}`)

    const tasks = Array.from({ length: PROCS }, (_, p) => ({
      op: 'bulk-append-vec',
      root: rootH,
      scope: scopeH,
      identity: IDENTITY,
      dims: DIMS,
      count: PER_PROC,
      prefix: `p${p}`,
      index: p,
    }))
    await runWorkersConcurrently(tasks)

    const lines = readFileSync(storeH.vecFileFor(scopeH), 'utf8').split('\n').filter((l) => l.trim())
    const headerLines = lines.filter((l) => l.startsWith('#'))
    assertEqual(headerLines.length, 1, '并发下只能有一个 #identity 头')
    assertEqual(headerLines[0], `#${IDENTITY}`, '头内容')
    assertEqual(lines.length, EXPECTED_TOTAL + 1, '80 行数据 + 1 个头')
    const seen = new Set(lines.filter((l) => !l.startsWith('#')).map((l) => l.split('\t')[0]))
    assertEqual(seen.size, EXPECTED_TOTAL, '向量 id 必须唯一且齐全')
    const missing = ids.filter((id) => !seen.has(id))
    assertEqual(missing.length, 0, `并发丢向量: ${missing.slice(0, 5).join(',')}`)
  })

  await test('删除记录会同步移除 .vec 里对应的向量', () => {
    const rec = storeF.save({ scope: SCOPE_F, kind: 'fact', content: '待删除的记录' })
    const v = new Float32Array(DIMS)
    v.fill(0.5)
    storeF.appendSidecar(SCOPE_F, rec.record.id, v)
    assert(storeF.readSidecar(SCOPE_F).vectors.has(rec.record.id), '向量应先写入')
    const del = storeF.deleteById(rec.record.id)
    assertEqual(del.deleted, true, '删除应成功')
    assert(!storeF.readSidecar(SCOPE_F).vectors.has(rec.record.id), '向量应被移除')
    const raw = readFileSync(storeF.vecFileFor(SCOPE_F), 'utf8')
    assert(!raw.includes(rec.record.id), '边车文件里不应再出现该 id')
    assert(raw.split('\n')[0] === `#${IDENTITY}`, '重写后身份头必须保留')
  })

  await test('deleteByQuery 也会清理向量', () => {
    const r1 = storeF.save({ scope: SCOPE_F, kind: 'fact', content: '批量删除目标 alpha' })
    const r2 = storeF.save({ scope: SCOPE_F, kind: 'fact', content: '批量删除目标 beta' })
    const keep = storeF.save({ scope: SCOPE_F, kind: 'fact', content: '要保留的记录' })
    for (const r of [r1, r2, keep]) storeF.appendSidecar(SCOPE_F, r.record.id, new Float32Array(DIMS))
    const res = storeF.deleteByQuery(SCOPE_F, '批量删除目标')
    assertEqual(res.deleted, 2, '应删 2 条')
    const side = storeF.readSidecar(SCOPE_F)
    assert(!side.vectors.has(r1.record.id) && !side.vectors.has(r2.record.id), '被删记录向量应移除')
    assert(side.vectors.has(keep.record.id), '保留记录的向量仍在')
  })

  await test('deleteByQuery 子串匹配按 normalizeContent 规范化', () => {
    storeF.save({ scope: SCOPE_F, kind: 'fact', content: 'Hello   World 大小写匹配' })
    const res = storeF.deleteByQuery(SCOPE_F, 'hello world')
    assert(res.deleted >= 1, '小写查询应命中')
  })

  await test('未声明 identity 就 readSidecar 会告警(上游 issue #1 的同款静默错误)', () => {
    const warnings = []
    const rootI = newTempRoot('warn')
    const noIdentity = new SharedStore(rootI, { onWarn: (m) => warnings.push(m) })
    const rec = noIdentity.save({ scope: SCOPE_F, kind: 'fact', content: '无身份边车' })
    appendFileSync(noIdentity.vecFileFor(SCOPE_F), `#some-model\t4\n${rec.record.id}\tAAAA\n`, 'utf8')
    noIdentity.readSidecar(SCOPE_F)
    assert(warnings.some((w) => w.includes('setVecIdentity')), `应产生告警,实际: ${warnings.join(' | ')}`)
  })

  // ============ 6. 别名映射 ============
  section('6. 别名映射 scopes.json')

  const rootJ = newTempRoot('names')
  await test('claim 登记别名,labelOf/nameOf/scopeOf 都能用', () => {
    const names = createScopeNames(rootJ)
    const scope = 'project:D:/dev/named'
    names.claim(scope, '我的工作区')
    assertEqual(names.nameOf(scope), '我的工作区', 'nameOf')
    assertEqual(names.labelOf(scope), '我的工作区', 'labelOf')
    assertEqual(names.scopeOf('我的工作区'), scope, 'scopeOf 反查')
    assert(existsSync(join(rootJ, 'scopes.json')), '应落盘 scopes.json')
  })

  await test('labelOf 在没有别名时回退到 scope 键本身', () => {
    const names = createScopeNames(rootJ)
    assertEqual(names.labelOf('project:D:/dev/never-named'), 'project:D:/dev/never-named', 'labelOf 回退')
    assertEqual(names.nameOf('project:D:/dev/never-named'), undefined, 'nameOf 无别名时 undefined')
  })

  await test('不同 scope 抢同一个名字会被拒绝(SCOPE_NAME_TAKEN)', () => {
    const names = createScopeNames(rootJ)
    let code = null
    try {
      names.claim('project:D:/dev/other', '我的工作区')
    } catch (err) {
      code = err?.code
    }
    assertEqual(code, 'SCOPE_NAME_TAKEN', '应报名字被占用')
  })

  await test('同名同 scope 是幂等的', () => {
    const names = createScopeNames(rootJ)
    names.claim('project:D:/dev/named', '我的工作区')
    assertEqual(names.nameOf('project:D:/dev/named'), '我的工作区', '幂等')
  })

  await test('release 删除别名', () => {
    const names = createScopeNames(rootJ)
    names.claim('project:D:/dev/temp-alias', '临时名字')
    assertEqual(names.release('project:D:/dev/temp-alias'), true, '应删除')
    assertEqual(names.nameOf('project:D:/dev/temp-alias'), undefined, '删除后无别名')
  })

  await test('并发 claim:坏 scopes.json 不会被互相覆盖', async () => {
    const rootK = newTempRoot('namesconc')
    const tasks = Array.from({ length: 4 }, (_, i) => ({
      op: 'claim-name',
      root: rootK,
      scope: `project:D:/dev/conc-name-${i}`,
      name: `别名-${i}`,
    }))
    const results = await runWorkersConcurrently(tasks)
    for (const [i, r] of results.entries()) {
      const parsed = JSON.parse(r.stdout.trim().split('\n').pop())
      assertEqual(parsed.ok, true, `worker#${i} claim 应成功: ${parsed.message}`)
    }
    const names = createScopeNames(rootK)
    for (let i = 0; i < 4; i++) {
      assertEqual(names.nameOf(`project:D:/dev/conc-name-${i}`), `别名-${i}`, `第 ${i} 条别名应在`)
    }
  })

  await test('损坏的 scopes.json 退化成空映射而不是抛错', () => {
    const rootL = newTempRoot('badnames')
    writeFileSync(join(rootL, 'scopes.json'), '{ 这不是 JSON', 'utf8')
    const names = new ScopeNames(join(rootL, 'scopes.json'), { root: rootL })
    assertEqual(Object.keys(names.load()).length, 0, '应返回空映射')
  })

  // ============ 7. 复用的打分/scope 纯函数 ============
  section('7. 复用的纯函数(spacing 与格式兼容)')

  await test('tokenize 同时处理拉丁词与 CJK 单字/二元组', () => {
    const t = tokenize('部署 pipeline 流程')
    assert(t.includes('pipeline'), '应含拉丁词')
    assert(t.includes('部署'), '应含 CJK 二元组')
    assert(t.includes('署'), '应含 CJK 单字')
  })

  await test('lexicalScore / buildStats 可用', () => {
    const docs = [new Set(tokenize('苹果 香蕉')), new Set(tokenize('苹果 橘子'))]
    const stats = buildStats(docs)
    const q = tokenize('苹果')
    assert(lexicalScore(q, docs[0], stats) > 0, '应命中')
  })

  await test('normalizeInPlace / cosine 可用', () => {
    const v = normalizeInPlace(new Float32Array([3, 4]))
    assert(Math.abs(Math.hypot(v[0], v[1]) - 1) < 1e-6, '应归一化到单位长度')
    assert(Math.abs(cosine(new Float32Array([1, 0]), new Float32Array([1, 0])) - 1) < 1e-6, '自身余弦为 1')
  })

  await test('scope 规范化 / 分类 / 分层', () => {
    assertEqual(normalizeScopeInput('global').scope, 'global', 'global')
    assertEqual(normalizeScopeInput('').kind, 'current-session', '空串')
    assertEqual(normalizeScopeInput('all').kind, 'all', 'all 只读')
    assertEqual(normalizeScopeInput('bad:colon').ok, false, '自定义名禁止冒号')
    assertEqual(scopeKind('session:x'), 'session', 'session 分类')
    assert(scopeTier('session:x') < scopeTier('global'), 'session 层级高于 global')
    assertEqual(isCustomScope('我的笔记'), true, '自定义名')
  })

  await test('scope 文件名与内容哈希公式与上游一致', () => {
    assertEqual(scopeFileName('global'), 'global.jsonl', 'global 映射')
    assertEqual(contentHash('s', 'A  B'), createHash('sha1').update('s::a b').digest('hex'), 'contentHash 公式')
  })

  // ============ 汇总 ============
  section('汇总')
  const total = passed + failures.length
  process.stdout.write(`  通过 ${passed}/${total}\n`)
  if (failures.length > 0) {
    process.stdout.write(`\n  \x1b[31m失败用例:\x1b[0m\n`)
    for (const f of failures) process.stdout.write(`    [${f.section}] ${f.name}\n      ${f.err?.message ?? f.err}\n`)
  }
  return failures.length === 0
}

// ------------------------------------------------------------------ 入口

const argvIndex = process.argv.indexOf('--worker')
if (argvIndex !== -1) {
  const task = JSON.parse(process.argv[argvIndex + 1])
  workerMain(task).then(
    (r) => process.stdout.write(`${JSON.stringify(r)}\n`),
    (err) => { process.stderr.write(`${err?.stack ?? err}\n`); process.exit(1) },
  )
} else {
  run().then(
    (ok) => {
      if (!KEEP) {
        // 只清理自己建的临时目录;真实 store 目录从头到尾没被打开过。
        for (const dir of tempRoots) {
          try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
        }
      }
      process.exit(ok ? 0 : 1)
    },
    (err) => { process.stderr.write(`${err?.stack ?? err}\n`); process.exit(1) },
  )
}
