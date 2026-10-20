/**
 * 向量后端独立自测 —— 验证探活 / 复用 / 嵌入 / 熔断 / 维度。
 * 用法:node scripts/selftest-vector.mjs
 *
 * 注意:这个脚本会真的**拉起** llama-server(除非已经有活的服务),
 * 所以默认只做只读探活 + 一次嵌入;加 --spawn 才测试自动拉起。
 */
import { VectorBackend, modelNameOf, poolingOf, resolveVectorConfig } from '../src/vector.js'
import { existsSync } from 'node:fs'

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? '  ✅ PASS' : '  ❌ FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`)
}

console.log('═'.repeat(70))
console.log('  向量后端自测')
console.log('═'.repeat(70))

// ── 配置解析 ────────────────────────────────────────────────────
console.log('\n[1] 配置解析')
// 用一个干净的环境测配置解析(不受调用者 ambient env 影响)
const cleanEnv = { ...process.env }
delete cleanEnv.DSH_MEMORY_EMBED_ENDPOINT
check('模型名推导 qwen3-embedding-0.6b',
  modelNameOf('D:\\dev\\models\\Qwen3-Embedding-0.6B-Q8_0.gguf') === 'qwen3-embedding-0.6b',
  modelNameOf('D:\\dev\\models\\Qwen3-Embedding-0.6B-Q8_0.gguf'))
const cfg = resolveVectorConfig({}, cleanEnv)
check('默认端口 8199(避开 DSH 的 8078)', cfg.port === 8199, `port=${cfg.port}`)
check('默认模型 qwen3-embedding-0.6b', cfg.modelName === 'qwen3-embedding-0.6b', cfg.modelName)
check('默认维度 1024(与 .vec 头一致)', cfg.dims === 1024, `dims=${cfg.dims}`)
check('identity = model\\tdims', cfg.modelName + '\t' + cfg.dims === 'qwen3-embedding-0.6b\t1024', `${cfg.modelName}\t${cfg.dims}`)
check('默认不 external(可以 spawn)', cfg.external === false, `external=${cfg.external}`)
check('Qwen3-Embedding 用 pooling=last(与 DSH 已有向量同空间)',
  cfg.pooling === 'last', `pooling=${cfg.pooling}`)
check('BGE 系自动切 cls', poolingOf('bge-m3') === 'cls', poolingOf('bge-m3'))
check('nomic 自动切 mean', poolingOf('nomic-embed-text-v1.5') === 'mean', poolingOf('nomic-embed-text-v1.5'))
check('DSH_MEMORY_EMBED_POOLING 可覆盖',
  resolveVectorConfig({}, { ...cleanEnv, DSH_MEMORY_EMBED_POOLING: 'cls' }).pooling === 'cls', '')

const cfgOff = resolveVectorConfig({}, { ...cleanEnv, DSH_MEMORY_VECTOR: 'off' })
check('DSH_MEMORY_VECTOR=off → 关闭', cfgOff.enabled === false, `enabled=${cfgOff.enabled}`)

const cfgExt = resolveVectorConfig({}, { ...cleanEnv, DSH_MEMORY_EMBED_ENDPOINT: 'http://127.0.0.1:8078/v1/embeddings' })
check('DSH_MEMORY_EMBED_ENDPOINT → external(永不 spawn)', cfgExt.external === true, `external=${cfgExt.external}`)
check('external 端点归一化出 baseUrl', cfgExt.baseUrl === 'http://127.0.0.1:8078', cfgExt.baseUrl)

// ── 探活 ────────────────────────────────────────────────────────
console.log('\n[2] 探活')
const backend = new VectorBackend({ root: process.cwd() }, process.env)
const alive = await backend.probe(1500)
console.log(`        探活 ${backend.cfg.healthUrl} → ${alive ? 'ok' : 'down'}`)
check('探活不抛异常', typeof alive === 'boolean', `alive=${alive}`)

// ── 嵌入 ────────────────────────────────────────────────────────
console.log('\n[3] 嵌入')
if (alive) {
  const state = await backend.ensureReady()
  check('ensureReady 复用已有服务(不 spawn)', state === 'reused' || state === 'external', `state=${state}`)
  check('不是我们自己 spawn 的', backend.owned === false, `owned=${backend.owned}`)

  const vecs = await backend.embed(['MCP 向量后端自测:量子纠缠'])
  check('嵌入返回向量', Array.isArray(vecs) && vecs.length === 1, `返回 ${vecs ? vecs.length : 'null'} 个`)
  check('维度 = 1024', vecs?.[0]?.length === 1024, `dims=${vecs?.[0]?.length}`)
  let norm = 0
  if (vecs?.[0]) for (const v of vecs[0]) norm += v * v
  check('L2 归一化(模长 ≈ 1)', Math.abs(Math.sqrt(norm) - 1) < 1e-3, `|v|=${Math.sqrt(norm).toFixed(6)}`)

  const sim = await backend.embed(['完全一样的一句话'])
  const other = await backend.embed(['毫不相干的内容 zzzz quantum banana'])
  if (sim?.[0] && other?.[0]) {
    const dot = sim[0].reduce((acc, v, i) => acc + v * other[0][i], 0)
    check('不相关文本的余弦相似度较低', dot < 0.8, `cos=${dot.toFixed(4)}`)
  }

  // 与 DSH 已存的向量比对:必须落在同一个向量空间里(否则混用两边的向量会得到垃圾结果)
  const dshStore = 'D:\\dev\\.dsh-memory-store'
  if (existsSync(`${dshStore}\\global.vec`) && existsSync(`${dshStore}\\global.jsonl`)) {
    const { readFileSync } = await import('node:fs')
    const rec = JSON.parse(readFileSync(`${dshStore}\\global.jsonl`, 'utf8').split('\n').filter(Boolean)[0])
    const vline = readFileSync(`${dshStore}\\global.vec`, 'utf8').split('\n')
      .find((l) => l.startsWith(`${rec.id}\t`))
    if (vline) {
      const bytes = Buffer.from(vline.split('\t')[1], 'base64')
      const stored = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)
      const fresh = (await backend.embed([rec.content]))?.[0]
      if (fresh) {
        let dot = 0
        let na = 0
        let nb = 0
        for (let i = 0; i < stored.length; i++) {
          dot += fresh[i] * stored[i]
          na += fresh[i] * fresh[i]
          nb += stored[i] * stored[i]
        }
        const cos = dot / (Math.sqrt(na) * Math.sqrt(nb))
        check('与 DSH 已存向量在同一空间(cos > 0.99)', cos > 0.99,
          `cos=${cos.toFixed(6)}  (pooling=${backend.cfg.pooling};若用错 pooling 这里会是 ~0.35)`)
      }
    }
  } else {
    console.log('        (跳过向量空间兼容性检查:DSH store 不可读)')
  }
} else {
  console.log('        ⚠️  没有活着的 embedding 服务,跳过嵌入测试')
  console.log('        (用 DSH_MEMORY_EMBED_ENDPOINT 指向已有服务,或先起 llama-server)')
}

// ── 熔断 ────────────────────────────────────────────────────────
console.log('\n[4] 熔断')
const broken = new VectorBackend({}, { ...process.env, DSH_MEMORY_EMBED_ENDPOINT: 'http://127.0.0.1:59999/v1/embeddings' })
await broken.probe(300)
const r1 = await broken.embed(['x'])
check('后端不可用时 embed 返回 null(不抛栈)', r1 === null, `返回 ${r1}`)
check('连续失败计数 = 1', broken.consecutiveFailures === 1, `failures=${broken.consecutiveFailures}`)
check('退避已翻倍', broken.backoffMs === 2000, `backoff=${broken.backoffMs}ms`)
const r2 = await broken.embed(['x'])
check('熔断打开后直接跳过(不再发请求)', r2 === null && broken.consecutiveFailures === 1,
  `failures=${broken.consecutiveFailures}`)

// ── 停止 ────────────────────────────────────────────────────────
console.log('\n[5] 生命周期')
const owned = new VectorBackend({}, { ...process.env, DSH_MEMORY_EMBED_ENDPOINT: 'http://127.0.0.1:59999/v1/embeddings' })
check('外部端点模式 owned=false(不杀别人的进程)', owned.owned === false, `owned=${owned.owned}`)
check('stop() 在没 spawn 时返回 false', owned.stop() === false, '')

console.log(`\n失败 ${failures} 项。`)
process.exit(failures > 0 ? 1 : 0)
