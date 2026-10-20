/**
 * MCP 服务端 —— 用 @modelcontextprotocol/sdk 的 stdio 传输暴露五个记忆工具。
 *
 * ⚠️ stdout 只能写协议消息!所有日志必须走 stderr(`console.error`)。
 *    在 stdout 上打一个字节的日志,客户端的 JSON-RPC 解析就会失败。
 *
 * Copyright (c) 2026 restregular
 * SPDX-License-Identifier: MIT
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { runTool, toolDescriptors } from './tools.js'

export const SERVER_NAME = 'dsh-memory-mcp'
export const SERVER_VERSION = '0.1.0'

/** 所有日志都走 stderr —— stdout 属于协议。 */
function log(message) {
  console.error(`[dsh-memory-mcp] ${message}`)
}

/**
 * 创建 MCP server 实例(不连接传输,便于测试)。
 *
 * @param {object} handlers  工具执行器(createTools 的返回值)
 */
export function createServer(handlers) {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDescriptors(),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name
    const args = request.params.arguments ?? {}
    const result = await runTool(handlers, name, args)
    // SDK 的 CallToolResultSchema 允许 isError;structuredContent 走 outputSchema。
    return {
      content: result.content,
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      ...(result.isError === true ? { isError: true } : {}),
    }
  })

  return server
}

/**
 * 把 server 接到 stdio 上。
 *
 * @param {object} handlers
 * @param {object} [opts] { onError }
 */
export async function startServer(handlers, opts = {}) {
  const server = createServer(handlers)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  log(`已启动 ${SERVER_NAME} v${SERVER_VERSION}(stdio)`)
  const close = async () => {
    try {
      await server.close()
    } catch {
      // 关闭失败不影响退出
    }
  }
  return { server, transport, close }
}
