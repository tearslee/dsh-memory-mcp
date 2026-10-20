/**
 * 向量端到端验证 —— 写一条记忆 → 写 .vec 边车 → 用**不同措辞**的语义查询召回。
 * 用法:node scripts/selftest-vector-e2e.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SharedStore } from '../src/store.js'
import { VectorBackend } from '../src/vector.js'

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? '  ✅ PASS' : '  ❌ FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`)
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-mcp-vec-e2e-'))
const store = new SharedStore(dir, { vecIdentity: 'qwen3-embedding-0.6b\t1024' })
const vector = new VectorBackend({ root: dir }, process.env)

const state = await vector.ensureReady()
console.log(`后端状态 = ${state},endpoint = ${vector.cfg.baseUrl},pooling = ${vector.cfg.pooling}`)

if (state === 'failed' || state === 'disabled') {
  console.log('  ⚠️  没有可用的 embedding 服务,跳过。先起一个 llama-server 或设 DSH_MEMORY_EMBED_ENDPOINT。')
  rmSync(dir, { recursive: true, force: true })
  process.exit(0)
}

// 自己拉起的后端要等模型加载完才能用(权重没进内存时请求会超时)。
if (state === 'spawned') {
  console.log('  等待模型加载…')
  const ready = await vector.waitUntilReady(180_000)
  console.log(`  模型就绪 = ${ready}`)
  if (!ready) {
    console.log('  ⚠️  模型加载超时,跳过嵌入部分。')
    vector.stop()
    await new Promise((r) => setTimeout(r, 300))
    rmSync(dir, { recursive: true, force: true })
    process.exit(0)
  }
}

const TEXT = '量子纠缠的纠缠态在测量后坍缩到计算基底,这是量子力学的核心特征'
const vec = (await vector.embed([TEXT]))?.[0]
check('能嵌入文本', Boolean(vec), vec ? `dims=${vec.length}` : 'null')

const rec = store.save({ scope: 'global', content: TEXT, kind: 'fact' }).record
store.appendSidecar('global', rec.id, vec)

const sc = store.readSidecar('global')
check('sidecar identity 正确', sc.identity === 'qwen3-embedding-0.6b\t1024', sc.identity)
check('sidecar 里能读回向量', sc.vectors.size === 1, `count=${sc.vectors.size}`)
const stored = sc.vectors.get(rec.id)
check('向量维度 1024', stored?.length === 1024, `dims=${stored?.length}`)

function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// 语义检索:措辞完全不同,词法几乎无重叠
const semantic = (await vector.embed(['纠缠态一测量就会坍缩,这是量子力学的基本性质']))?.[0]
const unrelated = (await vector.embed(['今天天气不错适合出去散步喝茶']))?.[0]
if (semantic && unrelated) {
  const s = cosine(semantic, stored)
  const u = cosine(unrelated, stored)
  console.log(`        语义相近(措辞不同) cos = ${s.toFixed(4)}`)
  console.log(`        完全无关           cos = ${u.toFixed(4)}`)
  check('语义相近 > minScore 0.5(会被向量通道召回)', s >= 0.5, `cos=${s.toFixed(4)}`)
  check('语义相近明显高于无关', s - u > 0.15, `差值=${(s - u).toFixed(4)}`)
}

// 停掉后端(只停我们自己 spawn 的)。**必须在删临时目录之前** ——
// 自己拉起的 llama-server 一直占着 <dir>/llama-server-mcp.log 的句柄,
// 目录就删不掉(EPERM)。
vector.stop()
await new Promise((r) => setTimeout(r, 300))

rmSync(dir, { recursive: true, force: true })
console.log(`\n失败 ${failures} 项。`)
process.exit(failures > 0 ? 1 : 0)
