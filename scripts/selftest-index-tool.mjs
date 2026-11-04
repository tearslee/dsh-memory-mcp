#!/usr/bin/env node
/**
 * `memory_index` / `memory_index_status` 工具专项自测。
 * 只用临时目录与 FakeStore，不碰真实 store。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTools, normalizeProjectPath, projectScopeKey, runTool } from '../src/tools.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-index-tool-'))
let passed = 0
const ok = (condition, message) => {
  assert.ok(condition, message)
  passed++
}
const eq = (actual, expected, message) => {
  assert.equal(actual, expected, message)
  passed++
}

class FakeStore {
  constructor() {
    this.records = new Map()
    this.n = 0
  }

  save(input) {
    for (const rec of this.records.values()) {
      if (rec.scope === input.scope && rec.content === input.content) {
        return { deduped: true, record: rec }
      }
    }
    const now = Date.now()
    const record = {
      id: `00000000-0000-4000-8000-${String(++this.n).padStart(12, '0')}`,
      scope: input.scope,
      kind: input.kind ?? 'note',
      content: input.content,
      tags: input.tags ?? [],
      source: input.source ?? { origin: 'explicit' },
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      importance: input.importance ?? 0.5,
      ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    }
    this.records.set(record.id, record)
    return { deduped: false, record }
  }

  listRecords({ scopeKeys } = {}) {
    let list = [...this.records.values()]
    if (scopeKeys) list = list.filter((record) => scopeKeys.includes(record.scope))
    return list.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  allScopeKeys() {
    return [...new Set([...this.records.values()].map((record) => record.scope))]
  }

  readSidecar() {
    return { identity: '', vectors: new Map() }
  }

  appendSidecar() {}
}

try {
  const project = join(root, 'project')
  const memoryDir = join(project, '.workbuddy', 'memory')
  mkdirSync(memoryDir, { recursive: true })
  writeFileSync(join(memoryDir, '2026-11-02.md'), `# 2026-11-02

## 一、采购订单

- 采购订单新增采购人员。

## 二、部署

- 回切 VPS。
`, 'utf8')
  writeFileSync(join(memoryDir, 'MEMORY.md'), `# 红线

## 不应进入索引

这条必须被跳过。
`, 'utf8')

  const store = new FakeStore()
  const handlers = createTools({
    store,
    config: { projectBasePath: project, defaultSaveScope: 'global' },
    vector: null,
  })
  const scope = projectScopeKey(normalizeProjectPath(project, root))

  let result = await runTool(handlers, 'memory_index', {})
  eq(result.structuredContent.scope, scope, '默认 project 指向当前项目')
  eq(result.structuredContent.dryRun, true, '默认 dryRun=true')
  eq(result.structuredContent.counts.new, 2, 'dry-run 识别两个章节')
  eq(store.records.size, 0, 'dry-run 不写 store')

  result = await runTool(handlers, 'memory_index', { dryRun: false })
  eq(result.structuredContent.confirmed, false, '未 confirm 返回 confirmed=false')
  eq(store.records.size, 0, '未 confirm 不落盘')

  result = await runTool(handlers, 'memory_index', { dryRun: false, confirm: true })
  eq(result.structuredContent.counts.new, 2, 'confirm 后写入两条')
  eq(store.records.size, 2, 'store 有两条')
  ok([...store.records.values()].every((record) => record.scope === scope), '只写 project')
  ok([...store.records.values()].every((record) => record.tags.includes('project-index')), '带 project-index tag')
  ok([...store.records.values()].every((record) => record.source?.origin === 'index'), 'source.origin=index')
  ok([...store.records.values()].every((record) => !record.content.includes('不应进入索引')), 'MEMORY.md 未被索引')

  result = await runTool(handlers, 'memory_index', { dryRun: false, confirm: true })
  eq(result.structuredContent.counts.new, 0, '重复写入不新增')
  eq(result.structuredContent.counts.supersede, 0, '重复写入不替换')
  eq(result.structuredContent.counts.skip, 2, '重复写入全部跳过')

  writeFileSync(join(memoryDir, '2026-11-02.md'), `# 2026-11-02

## 一、采购订单

- 采购订单新增采购人员与仓库字段。

## 二、部署

- 回切 VPS。
`, 'utf8')
  result = await runTool(handlers, 'memory_index', { dryRun: false, confirm: true })
  eq(result.structuredContent.counts.supersede, 1, '源变化替换一条')
  eq(result.structuredContent.counts.skip, 1, '未变章节跳过')
  const replacement = [...store.records.values()].find((record) => record.supersedes)
  ok(replacement?.supersedes, '替换记录带完整旧 UUID')
  ok(store.records.has(replacement.supersedes), 'supersedes 指向真实旧记录')

  result = await runTool(handlers, 'memory_index_status', { since: '2026-11-01' })
  eq(result.structuredContent.stale, 0, 'status 无 stale')
  eq(result.structuredContent.orphans.length, 0, 'status 无孤儿')
  eq(result.structuredContent.missingSources.length, 0, 'status 无源缺失')

  result = await runTool(handlers, 'memory_index', { sources: ['bogus'] })
  eq(result.structuredContent.code, 'TOOL_ERROR', '非法 sources 报错')
  ok(result.content[0].text.includes('sources 只能是'), '错误文案可读')

  result = await runTool(handlers, 'memory_index', { files: ['../../secrets.local.md'] })
  eq(result.structuredContent.code, 'TOOL_ERROR', '越界文件报错')

  console.log(`✓ selftest-index-tool: ${passed} assertions`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
