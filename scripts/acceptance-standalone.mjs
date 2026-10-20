/**
 * 独立运行验证：**不开 DSH**，MCP 服务能否自己拉起向量后端并完成语义检索。
 *
 * 前提由调用方保证：此刻没有任何 llama-server 在跑（8078 / 8199 均空闲），
 * 即模拟「DSH 未启动、也没有任何外部向量服务」的全新开机状态。
 *
 * 用法：node scripts/acceptance-standalone.mjs
 */
import { spawn, execSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ENTRY = 'D:/dev/dsh-memory-mcp/src/index.js'
const STORE = 'D:/dev/.dsh-memory-store'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
function listeningOn(port) {
  try {
    const out = execSync(`netstat -ano -p tcp | findstr ":${port} "`, { encoding: 'utf8' })
    return out.includes('LISTENING')
  } catch {
    return false
  }
}
function embedHealth(port) {
  try {
    const out = execSync(`curl -s -m 3 http://127.0.0.1:${port}/health`, { encoding: 'utf8' })
    return out.includes('ok')
  } catch {
    return false
  }
}

console.log('\n=== 独立运行验证：完全不开 DSH ===')
console.log(`前置：8078 空闲=${!listeningOn(8078)}，8199 空闲=${!listeningOn(8199)}，无任何 llama-server 进程`)
console.log('')

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [ENTRY, '--store-dir', STORE],
  env: {
    ...process.env,
    DSH_MEMORY_EMBED_EXE: 'D:\\dev\\llamacpp\\llama-server.exe',
    DSH_MEMORY_EMBED_MODEL: 'D:\\dev\\models\\Qwen3-Embedding-0.6B-Q8_0.gguf',
    DSH_MEMORY_EMBED_POOLING: 'last',
  },
  stderr: 'pipe',
})
let serverLog = ''
transport.stderr?.on('data', (d) => {
  serverLog += d.toString()
})

const client = new Client({ name: 'standalone-check', version: '1.0.0' })
await client.connect(transport)
check(true, 'MCP 服务在无 DSH 情况下冷启动成功')

console.log('\n1. 自拉起向量后端')
// index.js 的 ensureReady 是异步的，给模型加载留时间。
let ready = false
for (let i = 0; i < 60; i++) {
  await sleep(2000)
  if (embedHealth(8199)) {
    ready = true
    break
  }
}
check(ready, 'MCP 自己拉起了 llama-server（8199）', ready ? '' : `日志：${serverLog.split('\n').slice(-4).join(' / ')}`)
check(listeningOn(8199), '8199 端口在监听')
check(!listeningOn(8078), 'DSH 的 8078 始终未被占用（两者互不干扰）')

console.log('\n2. 工具可用')
const { tools } = await client.listTools()
check(tools.length === 5, 'tools/list 返回 5 个工具', tools.map((t) => t.name).join(','))

console.log('\n3. 无 DSH 时读取 DSH 早先写入的记忆')
const r = await client.callTool({
  name: 'memory_search',
  arguments: { query: 'dsh-memory 记忆插件 存储 JSONL 跨 agent', scope: 'all', topK: 5 },
})
const recs = r.structuredContent?.records ?? []
check(recs.length > 0, '读到了 DSH 之前写入的记忆', `命中 ${recs.length} 条`)
if (recs.length > 0) console.log(`     首条 score=${recs[0].score} scope=${recs[0].scope}`)

console.log('\n4. 无 DSH 时的写入能力')
const marker = `standalone-${Date.now()}`
const saved = await client.callTool({
  name: 'memory_save',
  arguments: { content: `${marker} 未开 DSH 时由 MCP 独立写入的验收记录`, kind: 'note', importance: 0.5 },
})
const newId = saved.structuredContent?.id
check(!!newId, 'memory_save 在无 DSH 时成功', `id=${newId?.slice(0, 8)} scope=${saved.structuredContent?.scope}`)

console.log('\n5. 语义召回（走刚拉起的向量后端，不是词法）')
// 措辞与原文完全不同、词法几乎无重叠，只有向量能召回。
const sem = await client.callTool({
  name: 'memory_search',
  arguments: { query: '不用打开主程序也能记录和检索', scope: 'all', topK: 10 },
})
const semRecs = sem.structuredContent?.records ?? []
const hit = semRecs.find((x) => x.content?.includes(marker))
check(!!hit, '语义相近但措辞不同也能召回', hit ? `score=${hit.score}` : `命中 ${semRecs.length} 条但不含目标`)

console.log('\n6. 清理')
if (newId) {
  const del = await client.callTool({ name: 'memory_forget', arguments: { id: newId } })
  check((del.structuredContent?.deleted ?? 0) >= 1, '清理掉验收记录')
}

await client.close()
await sleep(3000)

console.log('\n7. 退出后不残留孤儿进程')
// MCP 退出时应连带关掉自己拉起的 llama-server（DSH 不在场，无人接管）。
check(!embedHealth(8199), 'MCP 退出后向量后端随之关闭（无孤儿进程）')
check(!listeningOn(8199), '8199 已释放')

console.log(`\n=== 汇总：通过 ${pass}，失败 ${fail} ===`)
console.log(`\n服务端日志（供参考）：\n${serverLog.split('\n').slice(0, 12).join('\n')}`)
process.exit(fail === 0 ? 0 : 1)