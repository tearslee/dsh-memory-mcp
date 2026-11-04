/**
 * 模拟 ZCode 的 spawn 方式,验证 dsh-memory-mcp 在 ZCode 下能真正握手。
 *
 * 复刻 zcode.cjs 里 createTransport 的关键行为:
 *   cwd  = 工作区目录(配置里没写 cwd 时,ZCode 用 workspace 当 cwd)
 *   env  = { ...进程环境, ...配置里的 env }
 *   stderr = "pipe"  (ZCode 把 stderr 收到日志里)
 *
 * 用法:node scripts/probe-zcode-handshake.mjs [workspaceDir]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const cfgPath = join(homedir(), '.zcode', 'cli', 'config.json')
const raw = JSON.parse(readFileSync(cfgPath, 'utf8'))
const server = raw.mcp?.servers?.['dsh-memory']
if (!server) {
  console.error('✗ 配置里没有 dsh-memory 条目:', cfgPath)
  process.exit(1)
}

const workspace = resolve(process.argv[2] ?? process.cwd())
console.log('config      :', cfgPath)
console.log('workspace   :', workspace, '(ZCode 把工作区当 MCP 的 cwd)')

const t0 = Date.now()
const transport = new StdioClientTransport({
  command: server.command,
  args: server.args ?? [],
  cwd: workspace,
  env: { ...process.env, ...(server.env ?? {}) },
  stderr: 'pipe',
})

let stderrBuf = ''
transport.stderr?.on('data', (d) => { stderrBuf += d.toString() })

const client = new Client({ name: 'zcode-probe', version: '0.0.0' }, { capabilities: {} })

try {
  await client.connect(transport)
  console.log(`✓ 握手完成,耗时 ${Date.now() - t0}ms`)

  const listT0 = Date.now()
  const { tools } = await client.listTools()
  console.log(`✓ tools/list 返回 ${tools.length} 个工具,耗时 ${Date.now() - listT0}ms`)
  for (const t of tools) console.log('   -', t.name)

  // 真调一次读操作,确认能命中 DSH 已写的记忆
  const sT0 = Date.now()
  const res = await client.callTool({ name: 'memory_search', arguments: { query: 'memory', limit: 3 } })
  const payload = JSON.stringify(res.structuredContent ?? res.content)
  console.log(`✓ memory_search 调用完成,耗时 ${Date.now() - sT0}ms`)
  console.log('   返回摘要:', payload.slice(0, 400))
} catch (err) {
  console.error('✗ 失败:', err?.message ?? err)
  if (stderrBuf.trim()) console.error('--- server stderr ---\n' + stderrBuf.trim().slice(0, 3000))
  process.exitCode = 1
} finally {
  try { await client.close() } catch { /* ignore */ }
}

if (stderrBuf.trim()) {
  console.log('--- server stderr ---')
  console.log(stderrBuf.trim().slice(0, 2000))
}
