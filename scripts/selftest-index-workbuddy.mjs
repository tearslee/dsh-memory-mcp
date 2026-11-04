#!/usr/bin/env node
/**
 * index-workbuddy.mjs 的隔离自测：只使用临时 store，不碰真实记忆库。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SharedStore } from '../src/store.js'
import { normalizeProjectPath, projectScopeKey } from '../src/tools.js'
import {
  main,
  redactSecrets,
  splitMarkdownSections,
} from './index-workbuddy.mjs'
import { buildIndexPlan, inspectIndex } from '../src/workbuddy-index.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-index-workbuddy-'))
let passed = 0

function ok(condition, message) {
  assert.ok(condition, message)
  passed++
}

function eq(actual, expected, message) {
  assert.equal(actual, expected, message)
  passed++
}

try {
  const sections = splitMarkdownSections(`# 标题
## 一、真实章节
正文 A

\`\`\`md
## 代码块里的假标题
\`\`\`
尾巴

## 二、第二节
正文 B
`)
  eq(sections.length, 2, '只识别代码块外的二级标题')
  eq(sections[0].heading, '一、真实章节', '第一节标题')
  ok(sections[0].body.includes('## 代码块里的假标题'), '代码块内容保留在正文中')
  eq(sections[1].heading, '二、第二节', '第二节标题')

  const redacted = redactSecrets('password=abc token: def 密码：ghi\nAuthorization: Bearer xyz\nhttps://u:p@host')
  ok(!redacted.includes('abc') && redacted.includes('password=<密码>'), 'password 脱敏')
  ok(!redacted.includes('def') && redacted.includes('token: <密码>'), 'token 脱敏')
  ok(!redacted.includes('ghi') && redacted.includes('密码：<密码>'), '中文密码脱敏')
  ok(!redacted.includes('xyz'), 'Bearer 脱敏')
  ok(redacted.includes('https://u:<密码>@host'), 'URL userinfo 脱敏')

  const project = join(root, 'project')
  const memoryDir = join(project, '.workbuddy', 'memory')
  const storeDir = join(root, 'store')
  mkdirSync(memoryDir, { recursive: true })
  mkdirSync(storeDir, { recursive: true })
  const daily = join(memoryDir, '2026-11-02.md')
  writeFileSync(daily, `# 2026-11-02

## 一、采购订单

- ERP 采购订单新增采购人员。
- password=<test-value>

## 二、部署

- 回切 VPS。
`, 'utf8')

  const scope = projectScopeKey(normalizeProjectPath(project, root))
  const args = ['--project', project, '--store-dir', storeDir, '--files', '2026-11-02.md', '--no-vector']

  const dry = await main([...args, '--dry-run'], { DSH_MEMORY_VECTOR: 'off' })
  eq(dry.counts.new, 2, 'dry-run 识别两个章节')
  ok(!existsSync(join(storeDir, 'projects')) && !existsSync(join(storeDir, '.locks')), 'dry-run 不创建 projects/.locks')
  ok(!existsSync(join(storeDir, 'global.jsonl')), 'dry-run 不创建 global')

  const first = await main(args, { DSH_MEMORY_VECTOR: 'off' })
  eq(first.counts.new, 2, '首次写入两条')
  ok(!existsSync(join(storeDir, 'global.jsonl')), '首次写入不碰 global')

  const store = new SharedStore(storeDir)
  const records = [...store.readScope(scope).values()]
  eq(records.length, 2, 'project 域共两条')
  ok(records.every((r) => r.tags.includes('workbuddy') && r.tags.some((t) => t.startsWith('hash:'))), '每条带 hash 与 workbuddy tag')
  ok(records.every((r) => r.tags.some((t) => t.startsWith('来源:.workbuddy/memory/2026-11-02.md#'))), '每条带来源 tag')
  ok(records.every((r) => !r.content.includes('test-value')), '正文已脱敏')
  const purchaseRecord = records.find((r) => r.tags.some((t) => t.includes('#一、采购订单')))
  ok(purchaseRecord.content.includes('password=<密码>'), '正文保留脱敏占位')

  const second = await main(args, { DSH_MEMORY_VECTOR: 'off' })
  eq(second.counts.new, 0, '重复执行不新增')
  eq(second.counts.supersede, 0, '重复执行不替换')
  eq(second.counts.skip, 2, '重复执行全部跳过')
  eq([...store.readScope(scope).values()].length, 2, '重复执行记录数不变')

  const oldPurchase = records.find((r) => r.tags.some((t) => t.includes('#一、采购订单')))
  writeFileSync(daily, readFileSync(daily, 'utf8').replace('新增采购人员。', '新增采购人员与仓库字段。'), 'utf8')
  const third = await main(args, { DSH_MEMORY_VECTOR: 'off' })
  eq(third.counts.supersede, 1, '源章节变化时替换一条')
  eq(third.counts.skip, 1, '未变化章节跳过')
  const after = [...store.readScope(scope).values()]
  eq(after.length, 3, '替换保留历史并新增一条')
  const replacement = after.find((r) => r.supersedes === oldPurchase.id)
  ok(replacement, '新记录用完整旧 UUID supersedes')
  eq(replacement.supersedes, oldPurchase.id, 'supersedes 不是短前缀')
  ok(!existsSync(join(storeDir, 'global.jsonl')), '替换后仍不碰 global')

  // 共享模块的“默认日报”只收 YYYY-MM-DD.md，不能把 MEMORY.md / STATE.md 吞进去。
  const dailyOnly = buildIndexPlan({
    projectDir: project,
    memoryDir,
    sources: ['daily'],
    records: [],
  })
  eq(dailyOnly.files.length, 1, 'daily 来源只匹配日期文件')
  eq(dailyOnly.files[0].relativePath, '.workbuddy/memory/2026-11-02.md', 'daily 文件路径正确')

  const status = inspectIndex({
    projectDir: project,
    memoryDir,
    sources: ['daily'],
    since: '2026-11-01',
    records: [...store.readScope(scope).values()],
  })
  eq(status.stale, 0, '已索引内容在 status 中 stale=0')
  eq(status.orphans.length, 0, 'status 无孤儿')
  eq(status.missingSources.length, 0, 'status 无源缺失')

  console.log(`✓ selftest-index-workbuddy: ${passed} assertions`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
