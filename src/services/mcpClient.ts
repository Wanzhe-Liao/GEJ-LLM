const MCP_URL = import.meta.env.VITE_MCP_BRIDGE_URL || ''
const MCP_TOOL_NAME = 'analyze_medical_query'
const MCP_ANALYZE_TOOL = 'analyze_medical_query'
const MCP_RAG_TOOL = 'query_clinical_guidelines'

export class MCPFatalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MCPFatalError'
  }
}

// 并发控制：限制同时进行的 MCP 请求数量
// GLM-4.6 响应较慢，降低并发到 8 避免超时
const MAX_CONCURRENT_MCP_REQUESTS = 8
let currentMCPRequests = 0
const mcpRequestQueue: Array<() => void> = []

async function withConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
  // 等待获取执行槽位
  if (currentMCPRequests >= MAX_CONCURRENT_MCP_REQUESTS) {
    await new Promise<void>(resolve => mcpRequestQueue.push(resolve))
  }
  
  currentMCPRequests++
  try {
    return await fn()
  } finally {
    currentMCPRequests--
    // 释放槽位给队列中的下一个请求
    const next = mcpRequestQueue.shift()
    if (next) next()
  }
}

interface MCPToolCall {
  tool: string
  input: string
}

interface MCPResponse {
  content: string
  citations?: Array<{
    guidelineName: string
    source?: string
    quote?: string
  }>
}

interface MCPOptimizeResponse {
  optimized: any
  citations: Array<{           
    guidelineName: string
    source?: string
    quote?: string
  }>
  outputs: any[]
}

function extractRephrasedQuery(content: string, fallback: string): string {
  if (!content) return fallback
  const match = content.match(/Rephrased Query:\s*([\s\S]*?)(?:\n\s*\n|$)/i)
  if (match && match[1].trim()) {
    return match[1].trim()
  }
  return fallback
}

async function makeMCPRequest(endpoint: string, payload: any): Promise<any> {
  // 使用并发限制包装实际请求
  return withConcurrencyLimit(async () => {
    const controller = new AbortController()
    // 增加超时到 1200 秒（20分钟），高并发时 LightRAG 响应较慢
    const timeoutId = setTimeout(() => controller.abort(), 1200000)

    console.log(`🌐 [MCP] 请求: ${MCP_URL}${endpoint} (并发: ${currentMCPRequests}/${MAX_CONCURRENT_MCP_REQUESTS})`)
    console.log(`📤 [MCP] 工具: ${payload.tool}`)

    try {
      const res = await fetch(`${MCP_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      if (!res.ok) {
        const errorText = await res.text().catch(() => 'Unknown error')
        console.error(`❌ [MCP] 错误: ${res.status} - ${errorText}`)
        throw new Error(`MCP error: ${res.status} - ${errorText}`)
      }

      const result = await res.json()
      console.log(`✅ [MCP] 成功响应，citations数量: ${result.citations?.length || 0}`)
      return result
    } catch (error: any) {
      clearTimeout(timeoutId)
      if (error?.name === 'AbortError') {
        console.error(`⏱️ [MCP] 请求超时 (20分钟) - 服务器可能无法访问`)
        throw new Error('MCP request timeout - server may be unreachable')
      }
      console.error(`❌ [MCP] 请求失败:`, error)
      throw error
    }
  })
}

export async function callMCPTool(tool: string, input: string): Promise<MCPResponse> {
  return await makeMCPRequest('/mcp/call', { tool, input })
}

export async function optimizeWithMCP(
  baselineReport: any,
  phase: string,
  patientContext: string,
  mcpCalls?: MCPToolCall[]
): Promise<MCPOptimizeResponse> {
  if (!mcpCalls || mcpCalls.length === 0) {
    const diagnosis =
      baselineReport.diagnosis ||
      baselineReport.finalDiagnosis ||
      baselineReport.diagnosticConclusion ||
      baselineReport.caseSummary ||
      '未知诊断'
    const staging =
      baselineReport.staging ||
      baselineReport.clinicalStaging ||
      baselineReport.responseEvaluation ||
      '未知分期'
    const treatment =
      baselineReport.treatmentPlan ||
      baselineReport.adjuvantPlan ||
      baselineReport.surgicalPlan ||
      (Array.isArray(baselineReport.recommendations) ? baselineReport.recommendations[0] : undefined) ||
      '未知治疗方案'

    mcpCalls = [
      {
        tool: MCP_TOOL_NAME,
        input: `患者情况：${patientContext}。请分析以下临床要素的指南依据：诊断：${diagnosis}；分期：${staging}；治疗方案：${treatment}`
      },
      {
        tool: MCP_ANALYZE_TOOL,
        input: `分析关于"${diagnosis} ${staging}"的临床指南推荐`
      }
    ]
  }

  try {
    console.log(`🔧 [MCP] 开始执行 ${mcpCalls.length} 个MCP查询分析调用`)

    const analyzeResults = await Promise.all(
      mcpCalls.map(async (call, idx) => {
        const tool = MCP_ANALYZE_TOOL
        const input = call.input
        try {
          console.log(`  ${idx + 1}/${mcpCalls.length} 调用 ${tool} 进行查询分析...`)
          const result = await callMCPTool(tool, input)
          console.log(`  ✅ ${tool} 完成，citations: ${result.citations?.length || 0}`)
          return {
            tool,
            input,
            output: result.content,
            citations: result.citations || [],
            error: false as const
          }
        } catch (error: any) {
          console.error(`  ❌ MCP tool ${tool} failed:`, error)
          return {
            tool,
            input,
            output: `Error: ${error.message || String(error)}`,
            citations: [],
            error: true as const
          }
        }
      })
    )

    const failedAnalyzeCalls = analyzeResults.filter(result => result.error)
    if (failedAnalyzeCalls.length > 0) {
      throw new MCPFatalError(
        `MCP analyze_medical_query failed for ${failedAnalyzeCalls.length}/${mcpCalls.length} calls`
      )
    }

    const ragCalls = analyzeResults
      .map((result, idx) => {
        if (result.error) {
          return null
        }
        const originalCall = mcpCalls![idx]
        const query = extractRephrasedQuery(result.output, originalCall.input)
        return {
          index: idx,
          input: query
        }
      })
      .filter((item): item is { index: number; input: string } => !!item && !!item.input)

    console.log(`🔧 [MCP] 准备执行 ${ragCalls.length} 个 ${MCP_RAG_TOOL} 调用`)

    const ragResults = await Promise.all(
      ragCalls.map(async (call, idx) => {
        const tool = MCP_RAG_TOOL
        try {
          console.log(`  ${idx + 1}/${ragCalls.length} 调用 ${tool}...`)
          const result = await callMCPTool(tool, call.input)
          console.log(`  ✅ ${tool} 完成，citations: ${result.citations?.length || 0}`)
          return {
            tool,
            input: call.input,
            output: result.content,
            citations: result.citations || [],
            error: false as const
          }
        } catch (error: any) {
          console.error(`  ❌ MCP tool ${tool} failed:`, error)
          return {
            tool,
            input: call.input,
            output: `Error: ${error.message || String(error)}`,
            citations: [],
            error: true as const
          }
        }
      })
    )

    const failedRagCalls = ragResults.filter(result => result.error)
    if (failedRagCalls.length > 0) {
      throw new MCPFatalError(
        `MCP query_clinical_guidelines failed for ${failedRagCalls.length}/${ragResults.length} calls`
      )
    }

    if (ragResults.length === 0) {
      throw new MCPFatalError('MCP returned no guideline results; aborting optimization')
    }

    const allCitations = ragResults
      .filter(result => !result.error)
      .flatMap(result => result.citations)

    console.log(`📊 [MCP] 汇总结果: 总citations ${allCitations.length} 条`)

    const combinedOutputs = [
      ...analyzeResults.map(result => ({
        tool: result.tool,
        input: result.input,
        output: result.output,
        citations: result.citations,
        error: result.error
      })),
      ...ragResults.map(result => ({
        tool: result.tool,
        input: result.input,
        output: result.output,
        citations: result.citations,
        error: result.error
      }))
    ]

    return {
      optimized: baselineReport,
      citations: allCitations,
      outputs: combinedOutputs
    }
  } catch (error: any) {
    console.error('❌ [MCP] MCP优化失败:', error)

    if (error instanceof MCPFatalError) {
      throw error
    }

    return {
      optimized: baselineReport,
      citations: [{
        guidelineName: 'MCP Error',
        source: 'System',
        quote: `MCP integration failed: ${error.message}. Using baseline report without clinical guideline enhancement.`
      }],
      outputs: [{
        tool: 'error_handler',
        input: 'fallback',
        output: `MCP system unavailable: ${error.message}`,
        error: true
      }]
    }
  }
}
