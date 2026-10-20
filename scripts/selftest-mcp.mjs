#!/usr/bin/env node
/**
 * MCP 自测 —— 用官方 SDK 的 Client + StdioClientTransport 起**自己**,
 * 真实走一遍完整的 MCP 协议握手(initialize → tools/list → tools/call)。
 *
 * ⚠️ 绝不能碰真实 store:所有测试都在 `os.tmpdir()` 下的随机目录里跑,
 *    并且用 `--store-dir` 指向它。`D:/dev/.dsh-memory-store` 一个字节都不会动。
 *
 * 用法:
 *   node scripts/selftest-mcp.mjs
 *   node scripts/selftest-mcp.mjs --keep     # 保留临时目录以便排查
 */

import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const ENTRY = join(ROOT, 'src', 'index.js')

const keep = process.argv.includes('--keep')

/** 测试结果累加器。 */
const results = []
let failures = 0

function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failures++
  console.log(`${ok ? '  ✅ PASS' : '  ❌ FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`)
}

function section(title) {
  console.log(`\n${'═'.repeat(78)}\n  ${title}\n${'═'.repeat(78)}`)
}

function info(message) {
  console.log(`        ${message}`)
}

/** 生成一个只在本次运行里存在的随机临时目录。 */
const storeDir = mkdtempSync(join(tmpdir(), 'dsh-memory-mcp-selftest-'))
// 假的"项目目录",用来验证 project:<路径> 作用域
const projectDir = mkdtempSync(join(tmpdir(), 'dsh-memory-mcp-project-'))

console.log(`临时 store 目录 : ${storeDir}`)
console.log(`临时 project 目录: ${projectDir}`)
console.log(`真实 store 目录  : D:/dev/.dsh-memory-store(**不会**被访问)`)

/**
 * 起一个 MCP server 子进程并完成握手。
 * @param {object} env 追加的环境变量
 */
async function startServer(env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY, '--store-dir', storeDir, '--project', projectDir],
    env: { ...process.env, ...env },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'dsh-memory-mcp-selftest', version: '1.0.0' }, { capabilities: {} })
  const stderrChunks = []
  transport.stderr?.on('data', (c) => stderrChunks.push(c.toString()))
  await client.connect(transport)
  return { client, transport, stderrChunks }
}

/** 调一个工具,返回 { text, structured, isError }。 */
async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args })
  const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  return { text, structured: res.structuredContent, isError: res.isError === true, raw: res }
}

try {
  // ────────────────────────────────────────────────────────────
  section('1. initialize 握手')
  // ────────────────────────────────────────────────────────────
  const { client, stderrChunks } = await startServer()
  const serverInfo = client.getServerVersion()
  const serverCaps = client.getServerCapabilities()
  record('initialize 握手成功', Boolean(serverInfo?.name), `serverInfo=${JSON.stringify(serverInfo)}`)
  record('server 声明了 tools 能力', Boolean(serverCaps?.tools), `capabilities=${JSON.stringify(serverCaps)}`)

  // ────────────────────────────────────────────────────────────
  section('2. tools/list —— 5 个工具与 schema')
  // ────────────────────────────────────────────────────────────
  const list = await client.listTools()
  const toolNames = list.tools.map((t) => t.name).sort()
  const EXPECTED = ['memory_forget', 'memory_get', 'memory_list', 'memory_save', 'memory_search']
  record('tools/list 返回 5 个工具', list.tools.length === 5, `实际 ${list.tools.length} 个:${toolNames.join(', ')}`)
  record('工具名与预期一致', JSON.stringify(toolNames) === JSON.stringify(EXPECTED), `实际:${toolNames.join(', ')}`)

  const byName = Object.fromEntries(list.tools.map((t) => [t.name, t]))
  const saveSchema = byName.memory_save?.inputSchema
  const searchSchema = byName.memory_search?.inputSchema
  const listSchema = byName.memory_list?.inputSchema
  const getSchema = byName.memory_get?.inputSchema
  const forgetSchema = byName.memory_forget?.inputSchema

  record('memory_save.content 必填', saveSchema?.required?.includes('content') === true, `required=${JSON.stringify(saveSchema?.required)}`)
  record('memory_save.kind 默认 note + 6 个枚举值',
    saveSchema?.properties?.kind?.default === 'note'
    && saveSchema?.properties?.kind?.enum?.length === 6,
    `default=${saveSchema?.properties?.kind?.default} enum=${JSON.stringify(saveSchema?.properties?.kind?.enum)}`)
  record('memory_save.importance 范围 0~1',
    saveSchema?.properties?.importance?.minimum === 0 && saveSchema?.properties?.importance?.maximum === 1,
    `${saveSchema?.properties?.importance?.minimum}~${saveSchema?.properties?.importance?.maximum}`)
  record('memory_save 有 scope/path/tags/supersedes 字段',
    ['scope', 'path', 'tags', 'supersedes'].every((k) => saveSchema?.properties?.[k] !== undefined),
    `字段:${Object.keys(saveSchema?.properties ?? {}).join(', ')}`)

  record('memory_search.query 必填', searchSchema?.required?.includes('query') === true, `required=${JSON.stringify(searchSchema?.required)}`)
  record('memory_search.topK 默认 5、范围 1~20',
    searchSchema?.properties?.topK?.default === 5
    && searchSchema?.properties?.topK?.minimum === 1 && searchSchema?.properties?.topK?.maximum === 20,
    `default=${searchSchema?.properties?.topK?.default} range=${searchSchema?.properties?.topK?.minimum}~${searchSchema?.properties?.topK?.maximum}`)

  record('memory_list.limit 默认 50、范围 1~200',
    listSchema?.properties?.limit?.default === 50
    && listSchema?.properties?.limit?.minimum === 1 && listSchema?.properties?.limit?.maximum === 200,
    `default=${listSchema?.properties?.limit?.default} range=${listSchema?.properties?.limit?.minimum}~${listSchema?.properties?.limit?.maximum}`)

  record('memory_get.ids 必填且是 string[]',
    getSchema?.required?.includes('ids') === true && getSchema?.properties?.ids?.type === 'array',
    `required=${JSON.stringify(getSchema?.required)} type=${getSchema?.properties?.ids?.type}`)
  record('memory_get.ids 最多 50 个', getSchema?.properties?.ids?.maxItems === 50, `maxItems=${getSchema?.properties?.ids?.maxItems}`)

  record('memory_forget 有 id/query/scope 三个字段',
    forgetSchema?.properties?.id !== undefined
    && forgetSchema?.properties?.query !== undefined
    && forgetSchema?.properties?.scope !== undefined,
    `字段:${Object.keys(forgetSchema?.properties ?? {}).join(', ')}`)

  // ────────────────────────────────────────────────────────────
  section('3. memory_save —— 存一条带 kind/tags/importance 的记忆')
  // ────────────────────────────────────────────────────────────
  const CONTENT = 'MCP 自测记忆:Trae 与 WorkBuddy 通过 dsh-memory-mcp 共享同一份长期记忆数据'
  const saved = await call(client, 'memory_save', {
    content: CONTENT,
    scope: 'project',
    kind: 'procedure',
    tags: ['selftest', 'mcp'],
    importance: 0.8,
  })
  const savedId = saved.structured?.id
  record('memory_save 成功', saved.structured?.ok === true && Boolean(savedId), `text=${saved.text.split('\n')[0]}`)
  record('memory_save 返回 id', typeof savedId === 'string' && savedId.length > 0, `id=${savedId}`)
  record('memory_save 返回 deduped=false', saved.structured?.deduped === false, `deduped=${saved.structured?.deduped}`)
  record('memory_save 写进了 project 作用域',
    saved.structured?.scope === `project:${projectDir.replace(/\\/g, '/')}` || String(saved.structured?.scope).startsWith('project:'),
    `scope=${saved.structured?.scope}`)

  // ────────────────────────────────────────────────────────────
  section('4. memory_search —— 用关键词召回')
  // ────────────────────────────────────────────────────────────
  const searched = await call(client, 'memory_search', {
    query: 'Trae WorkBuddy 共享长期记忆',
    scope: 'project',
    topK: 5,
  })
  const hitIds = (searched.structured?.records ?? []).map((r) => r.id)
  record('memory_search 召回刚存的那条', hitIds.includes(savedId),
    `结果 ${hitIds.length} 条:${hitIds.join(', ')}`)
  record('检索结果带 score(4 位小数)', (searched.structured?.records ?? []).every((r) => /^\d+\.\d{4}$/.test(String(r.score.toFixed(4)))),
    `scores=${JSON.stringify((searched.structured?.records ?? []).map((r) => r.score))}`)
  record('检索文本按 [score] (scope/kind) 渲染', /\[\d+\.\d{4}\] \(.*\/.*\)/.test(searched.text),
    searched.text.split('\n').find((l) => l.startsWith('[')) ?? '(无)')

  // ────────────────────────────────────────────────────────────
  section('5. 幂等 —— 相同 content 再存一次')
  // ────────────────────────────────────────────────────────────
  const again = await call(client, 'memory_save', {
    content: CONTENT,
    scope: 'project',
    kind: 'procedure',
    tags: ['selftest', 'mcp'],
    importance: 0.8,
  })
  record('重复保存返回 deduped=true', again.structured?.deduped === true, `text=${again.text.split('\n')[0]}`)
  record('重复保存返回同一个 id', again.structured?.id === savedId, `id=${again.structured?.id}`)

  const afterDup = await call(client, 'memory_list', { scope: 'project', limit: 50 })
  record('重复保存后总数不变(只有 1 条)',
    afterDup.structured?.count === 1,
    `count=${afterDup.structured?.count}`)

  // ────────────────────────────────────────────────────────────
  section('6. memory_list + memory_get(8 位前缀)')
  // ────────────────────────────────────────────────────────────
  record('memory_list 列出了那条记忆',
    (afterDup.structured?.records ?? []).some((r) => r.id === savedId),
    `records=${JSON.stringify((afterDup.structured?.records ?? []).map((r) => r.shortId))}`)

  const prefix = String(savedId).slice(0, 8)
  const got = await call(client, 'memory_get', { ids: [prefix] })
  record('memory_get 用 8 位前缀取回成功',
    (got.structured?.records ?? []).some((r) => r.id === savedId),
    `prefix=${prefix} 取回=${JSON.stringify((got.structured?.records ?? []).map((r) => r.id))}`)
  record('memory_get 没有 missing', (got.structured?.missing ?? []).length === 0,
    `missing=${JSON.stringify(got.structured?.missing)}`)

  const gotDedup = await call(client, 'memory_get', { ids: [prefix, prefix, savedId] })
  record('memory_get 自动去重', gotDedup.structured?.count === 1, `count=${gotDedup.structured?.count}`)

  // ────────────────────────────────────────────────────────────
  section('7. memory_forget —— 按 id 删除,再搜不到')
  // ────────────────────────────────────────────────────────────
  const forgot = await call(client, 'memory_forget', { id: savedId })
  record('memory_forget 报告删了 1 条', forgot.structured?.deleted === 1, `text=${forgot.text.split('\n')[0]}`)

  const searched2 = await call(client, 'memory_search', { query: 'Trae WorkBuddy 共享长期记忆', scope: 'project', topK: 5 })
  const hitIds2 = (searched2.structured?.records ?? []).map((r) => r.id)
  record('删除后 memory_search 不再召回', !hitIds2.includes(savedId), `结果:${hitIds2.join(', ') || '(空)'}`)

  const listed = await call(client, 'memory_list', { scope: 'project', limit: 50 })
  record('删除后 memory_list 里也没有了',
    !(listed.structured?.records ?? []).some((r) => r.id === savedId),
    `count=${listed.structured?.count}`)

  // ────────────────────────────────────────────────────────────
  section('8. 错误处理 —— 校验失败返回清晰文本')
  // ────────────────────────────────────────────────────────────
  const noTarget = await call(client, 'memory_forget', {})
  record('forget 既不给 id 也不给 query → TARGET_REQUIRED',
    noTarget.isError && String(noTarget.structured?.code) === 'TARGET_REQUIRED',
    `code=${noTarget.structured?.code} text=${noTarget.text}`)

  const bothTargets = await call(client, 'memory_forget', { id: 'x', query: 'y' })
  record('forget 同时给 id 和 query → TARGET_AMBIGUOUS',
    bothTargets.isError && String(bothTargets.structured?.code) === 'TARGET_AMBIGUOUS',
    `code=${bothTargets.structured?.code} text=${bothTargets.text}`)

  const badImportance = await call(client, 'memory_save', { content: 'x', importance: 5 })
  record('importance 越界 → 报错并说明范围',
    badImportance.isError && String(badImportance.structured?.code) === 'IMPORTANCE_RANGE',
    `text=${badImportance.text}`)

  const badScope = await call(client, 'memory_search', { query: 'x', scope: 'bad:name' })
  record('非法 scope → SCOPE_INVALID(不静默回退)',
    badScope.isError && String(badScope.structured?.code) === 'SCOPE_INVALID',
    `text=${badScope.text}`)

  await client.close()

  // ────────────────────────────────────────────────────────────
  section('9. 向量模式 off / on 对比')
  // ────────────────────────────────────────────────────────────
  const VEC_CONTENT = '向量自测记忆:量子纠缠的纠缠态在测量后坍缩到计算基底'
  const vectorResults = {}

  // 探一下本机有没有活着的 embedding 服务 —— 有就指过去(避免自测去 spawn 一个
  // 又慢又留进程的 llama-server);没有就让它走"自动拉起"路径。
  let embedEndpoint = process.env.DSH_MEMORY_EMBED_ENDPOINT
  if (!embedEndpoint) {
    for (const port of [8199, 8078, 8200]) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1200) })
        if (res.ok) {
          embedEndpoint = `http://127.0.0.1:${port}`
          info(`发现活着的 embedding 服务:${embedEndpoint}`)
          break
        }
      } catch {
        // 继续试下一个端口
      }
    }
  }
  if (!embedEndpoint) info('没有活着的 embedding 服务,向量模式会自行拉起 llama-server(较慢)')

  for (const mode of ['off', 'on']) {
    const env = mode === 'off'
      ? { DSH_MEMORY_VECTOR: 'off' }
      : { DSH_MEMORY_VECTOR: 'on', ...(embedEndpoint ? { DSH_MEMORY_EMBED_ENDPOINT: embedEndpoint } : {}) }
    const s = await startServer(env)
    const r = await call(s.client, 'memory_save', { content: VEC_CONTENT, scope: 'project', kind: 'fact' })
    const sc = await call(s.client, 'memory_search', { query: '量子纠缠 坍缩', scope: 'project', topK: 5 })
    vectorResults[mode] = {
      saved: r.structured?.ok === true,
      count: sc.structured?.count ?? 0,
      hit: (sc.structured?.records ?? []).map((x) => x.id),
      stderr: s.stderrChunks.join(''),
    }
    info(`模式 ${mode}:save=${vectorResults[mode].saved} search 命中 ${vectorResults[mode].count} 条`)
    await s.client.close()
  }
  record('向量关闭时仍能检索(纯词法)', vectorResults.off.count >= 1, `off 命中 ${vectorResults.off.count} 条`)
  record('向量开启时仍能检索(词法 + 向量混合)', vectorResults.on.count >= 1, `on 命中 ${vectorResults.on.count} 条`)
  info(`off stderr: ${vectorResults.off.stderr.trim().split('\n').filter(Boolean).slice(0, 4).join(' | ')}`)
  info(`on  stderr: ${vectorResults.on.stderr.trim().split('\n').filter(Boolean).slice(0, 4).join(' | ')}`)

  // ────────────────────────────────────────────────────────────
  section('10. 存储落盘检查')
  // ────────────────────────────────────────────────────────────
  const files = existsSync(storeDir) ? readdirSync(storeDir, { recursive: true }) : []
  const jsonlFiles = files.filter((f) => String(f).endsWith('.jsonl'))
  record('临时 store 目录里写出了 jsonl', jsonlFiles.length > 0, `文件:${files.join(', ')}`)
  const globalFile = join(storeDir, 'global.jsonl')
  if (existsSync(globalFile)) {
    const lines = readFileSync(globalFile, 'utf8').trim().split('\n').filter(Boolean)
    info(`global.jsonl 有 ${lines.length} 行`)
  }
  record('真实 store 目录未被创建', !existsSync('D:/dev/.dsh-memory-store/.selftest-should-not-exist'),
    '(仅检查测试专属标记文件)')

  // ────────────────────────────────────────────────────────────
  section('11. server 端 stderr 日志(确认 stdout 只有协议)')
  // ────────────────────────────────────────────────────────────
  const stderrText = stderrChunks.join('')
  record('server 把日志写到了 stderr', stderrText.includes('[dsh-memory-mcp]'),
    stderrText.trim().split('\n').slice(0, 5).join(' | '))

  // ────────────────────────────────────────────────────────────
  section('汇总')
  // ────────────────────────────────────────────────────────────
  console.log(`共 ${results.length} 项检查,通过 ${results.length - failures} 项,失败 ${failures} 项。`)
  if (failures > 0) {
    console.log('\n失败项:')
    for (const r of results.filter((x) => !x.ok)) {
      console.log(`  - ${r.name}\n      ${r.detail}`)
    }
  }
} catch (error) {
  console.error('\n自测异常终止:', error)
  failures++
} finally {
  // 清理临时目录。llama-server 可能还占着日志文件的句柄,所以重试几次。
  if (!keep) {
    for (const dir of [storeDir, projectDir]) {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
          break
        } catch (error) {
          if (attempt === 4) {
            console.error(`\n⚠️  清理 ${dir} 失败(可能有残留进程占用):${error.message}`)
          } else {
            await new Promise((r) => setTimeout(r, 400))
          }
        }
      }
    }
    console.log(`\n已清理临时目录:\n  ${storeDir}\n  ${projectDir}`)
  } else {
    console.log(`\n(--keep)保留临时目录:\n  ${storeDir}\n  ${projectDir}`)
  }
}

process.exit(failures > 0 ? 1 : 0)
