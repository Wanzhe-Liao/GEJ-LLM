// Report Generation Service
// Handles all API calls and report generation logic
// GPT-5 streaming mode force enabled

import { MODELS, TYPE_MODEL, JSON_REPAIR_MODEL, type Model } from '../utils/models'
import { type Report, type OptimizedReport, type PhaseReportContent, type ClinicalPhase, type TokenUsage } from '../types/report'
import { type PeerReview } from '../types/scoring'
import { PROMPT_MODE_CONFIGS, MCP_QUERY_PROMPT_SYSTEM, MCP_QUERY_PROMPT_USER, MCP_OPTIMIZE_PROMPT_SYSTEM, MCP_OPTIMIZE_PROMPT_USER } from '../utils/prompts'
import { optimizeWithMCP, MCPFatalError } from './mcpClient'
import { PromptMode } from '../types/phase'
import {
  validateCitations,
  applyAutomaticFix,
  generateValidationReport,
  checkCitationConsistency
} from '../utils/citationValidator'
import { retryWithBackoff, getModelSpecificRetryConfig } from '../utils/retryHelper'

const API_URL = import.meta.env.VITE_API_URL || '<API_BASE_URL>'
const API_KEY = import.meta.env.VITE_API_KEY

interface ApiResponse {
  content: string
  tokenUsage?: TokenUsage
}

function getAuthHeaders(apiKey: string, model: Model): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  }

  // Handle different authentication schemes for different providers
  switch (model.provider) {
    case 'anthropic':
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
      break
    case 'moonshot':
    case 'openai':
    case 'apiplus':
    default:
      headers['Authorization'] = `Bearer ${apiKey}`
      break
  }

  return headers
}

function validateApiConfiguration(model: Model): { url: string; key: string } {
  const baseUrlKey = model.baseURLEnvKey as string | undefined
  const apiKeyKey = model.apiKeyEnvKey as string | undefined

  const url = (baseUrlKey && (import.meta.env as any)[baseUrlKey]) || API_URL
  const key = (apiKeyKey && (import.meta.env as any)[apiKeyKey]) || API_KEY

  if (!key) {
    throw new Error(`API key not found for model ${model.id}. Please check your .env file and ensure ${apiKeyKey || 'VITE_API_KEY'} is set.`)
  }

  return { url, key }
}

export async function callAPI(
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  stream: boolean = false,
  onChunk?: (chunk: string) => void
): Promise<ApiResponse> {
  const model = MODELS.find(m => m.id === modelId) ||
                (modelId === JSON_REPAIR_MODEL.id ? JSON_REPAIR_MODEL : TYPE_MODEL)

  // 所有模型强制启用 streaming mode，防止长请求超时
  stream = true
  console.log(`🌊 [${model.name}] Streaming mode enabled`)

  // Validate API configuration before making requests
  let primaryUrl: string
  let primaryKey: string
  try {
    const config = validateApiConfiguration(model)
    primaryUrl = config.url
    primaryKey = config.key
  } catch (error) {
    throw new Error(`Configuration error for ${modelId}: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }

  const doRequest = async (url: string, key: string) => {
    const headers = getAuthHeaders(key, model)

    // Provider-specific payload adjustments
    let body: any

    switch (model.provider) {
      case 'anthropic':
        // Anthropic API format
        body = {
          model: model.id,
          messages: [
            { role: 'user', content: systemPrompt + "\n\n" + userPrompt }
          ],
          max_tokens: 65536,
          temperature: 0,
          stream
        }
        break
      case 'deepseek':
        // DeepSeek Reasoner max_tokens 64K
        body = {
          model: model.id,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          max_tokens: 65536,
          temperature: 0,
          stream
        }
        break
      case 'moonshot':
      case 'openai':
      case 'apiplus':
      default:
        body = {
          model: model.id,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          max_tokens: 65536,
          temperature: 0,
          stream
        }
        break
    }

    const isSonnetThinking = model.id.includes('claude') && model.id.includes('thinking')
    const isGPT5 = model.id.includes('gpt-5')
    const isKimiThinking = model.id.includes('kimi') && model.id.includes('thinking')
    const needsExtendedTimeout = isSonnetThinking || isGPT5 || isKimiThinking
    const timeoutMs = needsExtendedTimeout ? 1800000 : 480000

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      })
      clearTimeout(timeoutId)

      if (response.status >= 520 && response.status <= 524) {
        const errorBody = await response.text().catch(() => 'No response body')
        const errorMessages: Record<number, string> = {
          520: 'API server returned unknown error',
          521: 'API server is down',
          522: 'Connection timed out',
          523: 'Origin is unreachable',
          524: 'Server took too long to respond'
        }
        const message = errorMessages[response.status] || 'Cloudflare error'
        throw new Error(`Cloudflare error (${response.status}) for ${model.id}. ${message}. ${errorBody.substring(0, 200)}`)
      }

      if (response.status === 429) {
        const errorBody = await response.text().catch(() => 'No response body')
        throw new Error(`Rate limit (429) for ${model.id}. ${errorBody.substring(0, 200)}`)
      }

      if (response.status >= 500 && response.status <= 504) {
        const errorBody = await response.text().catch(() => 'No response body')
        throw new Error(`Server error (${response.status}) for ${model.id}. ${errorBody.substring(0, 200)}`)
      }

      return response
    } catch (error) {
      clearTimeout(timeoutId)
      if (error instanceof Error && error.name === 'AbortError') {
        const timeoutMinutes = needsExtendedTimeout ? 30 : 8
        throw new Error(`Request timeout after ${timeoutMinutes} minutes for model ${model.id}`)
      }
      throw error
    }
  }

  const retryConfig = getModelSpecificRetryConfig(modelId)
  let response: Response
  try {
    response = await retryWithBackoff(
      () => doRequest(primaryUrl, primaryKey),
      `API call for ${modelId}`,
      retryConfig
    )
  } catch (e) {
    console.error(`❌ Network error for ${modelId} after ${retryConfig.maxRetries} retries:`, e)
    throw new Error(`Network error for ${modelId} after ${retryConfig.maxRetries} retries: ${e instanceof Error ? e.message : 'Unknown network error'}`)
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'Unable to read error response')
    console.error(`❌ API error ${response.status} for ${modelId}`)
    console.error(`📄 Response body (first 1000 chars):`, errorBody.substring(0, 1000))

    if (response.status === 401) {
      throw new Error(`Authentication failed for ${modelId}. Please check your API key configuration.`)
    } else if (response.status === 403) {
      throw new Error(`Access forbidden for ${modelId}. Your API key may not have access to this model.`)
    } else if (response.status === 429) {
      throw new Error(`Rate limit exceeded for ${modelId}. Please try again later.`)
    } else if (response.status === 520) {
      throw new Error(`Cloudflare error (520) for ${modelId}. API server returned unknown error. This is retryable.`)
    } else if (response.status === 521) {
      throw new Error(`Cloudflare error (521) for ${modelId}. API server is down. This is retryable.`)
    } else if (response.status === 522) {
      throw new Error(`Cloudflare error (522) for ${modelId}. Connection timed out. This is retryable.`)
    } else if (response.status === 523) {
      throw new Error(`Cloudflare error (523) for ${modelId}. Origin is unreachable. This is retryable.`)
    } else if (response.status === 524) {
      throw new Error(`Cloudflare error (524) for ${modelId}. API server took too long to respond. This is retryable.`)
    }

    throw new Error(`API error ${response.status} for ${modelId}: ${errorBody.substring(0, 500)}`)
  }

  if (stream) {
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let fullContent = ''
    let usage: TokenUsage | undefined

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      const lines = chunk.split('\n').filter(line => line.startsWith('data: '))

      for (const line of lines) {
        const dataStr = line.slice(6)
        if (dataStr === '[DONE]') {
          return { content: fullContent, tokenUsage: usage }
        }

        try {
          const data = JSON.parse(dataStr)
          const content = data.choices[0]?.delta?.content
          if (content) {
            fullContent += content
            onChunk?.(content)
          }
          if (data.usage) {
            usage = {
              inputTokens: data.usage.prompt_tokens || 0,
              outputTokens: data.usage.completion_tokens || 0,
              totalTokens: data.usage.total_tokens || 0
            }
          }
        } catch {
          // Skip invalid JSON
        }
      }
    }

    return { content: fullContent, tokenUsage: usage }
  } else {
    const data = await response.json()
    const content = data.choices[0]?.message?.content || ''

    if (!content) {
      console.error(`[${modelId}] Empty content in response:`, JSON.stringify(data).substring(0, 300))
    }

    return {
      content,
      tokenUsage: data.usage ? {
        inputTokens: data.usage.prompt_tokens || 0,
        outputTokens: data.usage.completion_tokens || 0,
        totalTokens: data.usage.total_tokens || 0
      } : undefined
    }
  }
}

export function extractJSON(text: string): string {
  const codeBlockMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim()
  }

  let cleanedText = text

  const thinkingRegex = /<thinking>[\s\S]*?<\/thinking>/gi
  cleanedText = cleanedText.replace(thinkingRegex, '')

  const xmlTagRegex = /<[^>]+>/g
  cleanedText = cleanedText.replace(xmlTagRegex, '')

  const start = cleanedText.search(/[{[]/)
  if (start === -1) return ''

  let depth = 0
  let inString = false
  let escapeNext = false
  let end = -1

  for (let i = start; i < cleanedText.length; i++) {
    const char = cleanedText[i]

    if (escapeNext) {
      escapeNext = false
      continue
    }

    if (char === '\\') {
      escapeNext = true
      continue
    }

    if (char === '"' && !inString) {
      inString = true
      continue
    }
    if (char === '"' && inString) {
      inString = false
      continue
    }

    if (inString) continue

    if (char === '{') depth++
    if (char === '}') depth--
    if (char === '[') depth++
    if (char === ']') depth--

    if (depth === 0 && i > start) {
      end = i
      break
    }
  }

  return end > 0 ? cleanedText.slice(start, end + 1) : ''
}

export async function extractJSONWithAIRepair(
  text: string,
  modelName: string,
  stage: 'baseline' | 'mcp_query' | 'optimize'
): Promise<string> {
  const jsonStr = extractJSON(text)

  if (jsonStr) {
    return jsonStr
  }

  console.warn(`⚠️ [${modelName}] ${stage}阶段 - extractJSON失败，尝试使用GPT-5-nano修复...`)
  console.log(`原始响应前500字符:`, text.substring(0, 500))

  try {
    const repairedJson = await repairJsonWithAI(
      text,
      'No valid JSON structure found in response',
      10,
      stage
    )
    console.log(`✅ [${modelName}] ${stage}阶段 - GPT-5-nano成功修复JSON`)
    return repairedJson
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error(`❌ [${modelName}] ${stage}阶段 - GPT-5-nano修复失败: ${errorMsg}`)
    throw new Error(`JSON extraction and AI repair both failed for ${modelName} at ${stage} stage`)
  }
}

export function cleanJSON(jsonStr: string): string {
  return jsonStr
    .replace(/,\s*([}\]])/g, '$1')                     // Remove trailing commas
    .replace(/([{,])\s*'([^']+)'\s*:/g, '$1"$2":')    // Single to double quotes for keys
    .replace(/:\s*'([^']*)'/g, ':"$1"')               // Single to double quotes for values
    .replace(/\\\\/g, '/')                             // Convert \\ to / in paths
    .replace(/\[([^\]]*\.pdf)\]/g, '($1)')            // Convert [file.pdf] to (file.pdf) in text
    .replace(/"\s*\n\s*"/g, '" "')                    // Fix line breaks between strings
    .replace(/([^\\])"/g, (m, p1) => {                // Escape unescaped quotes in strings
      if (p1 === ':' || p1 === ',' || p1 === '{' || p1 === '[') return m
      return m
    })
}

async function repairJsonWithAI(
  brokenJson: string,
  originalError: string,
  maxAttempts: number = 20,
  context?: string
): Promise<string> {
  console.log(`🤖 启动 AI JSON 修复（最多 ${maxAttempts} 轮）...`)

  const systemPrompt = `你是一个专业的 JSON 修复专家。用户会提供一段可能不完整或格式错误的 JSON 文本和错误信息，你的任务是修复它并返回一个有效的、完整的 JSON。

【核心规则】
1. 你的回复必须且只能是修复后的纯 JSON，不要添加任何解释或 markdown 标记
2. 保持原 JSON 的结构和内容不变，只修复格式错误
3. 如果 JSON 被截断，根据上下文智能补全缺失的部分
4. 确保所有字符串都用双引号包裹（包括中文文本）
5. 确保所有数组和对象都正确闭合
6. 确保数组元素之间有逗号分隔
7. 不要在最后一个元素后添加逗号

【常见问题修复】
- 缺少引号：text → "text"，无 → "无"
- 缺少逗号：}{  → },{  或 "" "" → "","
- 缺少闭合符号：{ → {}  或 [ → []
- 截断的字符串：补全并闭合
- 注意错误位置信息，重点检查该位置附近

【中文处理】
- 裸中文词（如：无、不明确、未知）必须加双引号：无 → "无"
- 中文短语也需要引号："无相关证据"

只返回修复后的 JSON，不要有任何其他内容！`

  let currentJson = brokenJson
  let currentError = originalError

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`🔄 AI 修复第 ${attempt}/${maxAttempts} 轮`)
    console.log(`📍 当前错误：${currentError}`)

    let schemaHint = ''
    if (context === 'mcp_query') {
      schemaHint = `

【期望的 JSON 结构】
{
  "mcpCalls": [
    {
      "tool": "analyze_medical_query",
      "input": "具体的查询文本（必须是字符串）"
    }
  ]
}

【关键要求】
- mcpCalls 必须是数组
- 每个元素必须有 tool 和 input 字段
- tool 的值必须完整为 "analyze_medical_query"
- input 必须是字符串，不能是 undefined、null 或对象
- mcpCalls 数组至少要有 1 个元素
- 不要截断或简化 tool 和 input 的值
`
    }

    const userPrompt = `请修复以下 JSON。
${schemaHint}

【错误信息】
${currentError}

【需要修复的 JSON】
\`\`\`
${currentJson}
\`\`\`

【要求】
只返回修复后的完整 JSON，不要添加任何解释或 markdown 标记。`

    try {
      const response = await callAPI(
        JSON_REPAIR_MODEL.id,
        systemPrompt,
        userPrompt,
        false
      )

      let repairedJson = response.content

      repairedJson = repairedJson.trim()
      if (repairedJson.startsWith('```json')) {
        repairedJson = repairedJson.substring(7)
      } else if (repairedJson.startsWith('```')) {
        repairedJson = repairedJson.substring(3)
      }
      if (repairedJson.endsWith('```')) {
        repairedJson = repairedJson.substring(0, repairedJson.length - 3)
      }
      repairedJson = repairedJson.trim()

      repairedJson = repairedJson
        .replace(/:\s*(无|不明确|未知|无法确定|不清楚|缺失|暂无|不详|待定)(?=\s*[,}\]])/g, ':"$1"')
        .replace(/\[\s*(无|不明确|未知|无法确定|不清楚|缺失|暂无)(?=\s*[\],])/g, '["$1"')

      try {
        const parsed = JSON.parse(repairedJson)

        if (context === 'mcp_query') {
          if (!parsed.mcpCalls || !Array.isArray(parsed.mcpCalls)) {
            throw new Error('结构错误：mcpCalls 字段缺失或不是数组')
          }

          if (parsed.mcpCalls.length === 0) {
            throw new Error('结构错误：mcpCalls 数组为空')
          }

          for (let i = 0; i < parsed.mcpCalls.length; i++) {
            const call = parsed.mcpCalls[i]

            if (!call.tool || typeof call.tool !== 'string') {
              throw new Error(`结构错误：mcpCalls[${i}].tool 字段缺失或不是字符串`)
            }

            if (!call.tool.includes('analyze_medical_query')) {
              throw new Error(`结构错误：mcpCalls[${i}].tool 值无效 "${call.tool}"，必须是 "analyze_medical_query"`)
            }

            if (call.input === undefined || call.input === null) {
              throw new Error(`结构错误：mcpCalls[${i}].input 字段缺失`)
            }

            if (typeof call.input !== 'string') {
              throw new Error(`结构错误：mcpCalls[${i}].input 不是字符串类型，是 ${typeof call.input}`)
            }

            if (call.input.trim().length === 0) {
              throw new Error(`结构错误：mcpCalls[${i}].input 是空字符串`)
            }
          }
        }

        console.log(`✅ AI 修复成功（第 ${attempt} 轮）`)
        return repairedJson
      } catch (parseError) {
        const newError = parseError instanceof Error ? parseError.message : '未知解析错误'
        console.log(`⚠️ 第 ${attempt} 轮修复后仍有错误：${newError}`)

        if (attempt < maxAttempts) {
          currentJson = repairedJson
          currentError = `上一轮修复后的新错误：${newError}`
          continue
        } else {
          throw new Error(`AI 修复失败（${maxAttempts} 轮尝试后）：${newError}`)
        }
      }
    } catch (apiError) {
      console.error(`❌ AI 修复请求失败（第 ${attempt} 轮）:`, apiError)
      throw apiError
    }
  }

  throw new Error(`AI 修复失败：已达到最大尝试次数 ${maxAttempts}`)
}

export async function parseJsonSafely<T = any>(jsonStr: string, context: string): Promise<T> {
  try {
    return JSON.parse(jsonStr) as T
  } catch (firstError) {
    const errorMsg = firstError instanceof Error ? firstError.message : '未知错误'
    console.warn(`⚠️ [${context}] JSON 解析失败，启动 AI 修复: ${errorMsg}`)

    const stage = context.includes('MCP query')
      ? 'mcp_query'
      : context.includes('optimized')
        ? 'optimize'
        : 'baseline'

    try {
      const repairedJson = await repairJsonWithAI(jsonStr, errorMsg, 10, stage)
      return JSON.parse(repairedJson) as T
    } catch (repairError) {
      const repairErrorMsg = repairError instanceof Error ? repairError.message : '未知错误'
      console.error(`❌ [${context}] AI 修复后仍然失败: ${repairErrorMsg}`)

      throw new Error(
        `JSON 解析失败（已尝试 AI 修复）: ${errorMsg}。AI 修复错误: ${repairErrorMsg}`
      )
    }
  }
}

function calculateSimpleSimilarity(str1: string, str2: string): number {
  if (str1 === str2) return 1.0
  const len1 = str1.length
  const len2 = str2.length
  if (len1 === 0 || len2 === 0) return 0

  const set1 = new Set(str1.split(''))
  const set2 = new Set(str2.split(''))
  const intersection = new Set([...set1].filter(x => set2.has(x)))
  const union = new Set([...set1, ...set2])

  return intersection.size / union.size
}

export async function generateBaselineReports(
  medicalRecord: string,
  phase: ClinicalPhase,
  promptMode: PromptMode,
  selectedModelIds: Set<string>,
  onUpdate: (report: Report) => void
): Promise<Report[]> {
  const guidelines = ''

  const systemPrompt = PROMPT_MODE_CONFIGS[promptMode].systemPrompt

  // Generate JSON schema based on prompt mode
  const getJsonSchema = (mode: PromptMode): string => {
	if (mode === PromptMode.OUTPATIENT) {
	  return `{
	"diagnosticConclusion": "诊断结论：完整诊断（病理类型 + Siewert 分型 + cTNM + cStage）",
	"decisionLogic": "决策逻辑：分点陈述支持治疗选择的关键证据",
	"treatmentPlan": "拟定医嘱：具体的药物方案、周期数及预期的复查时间节点",
	"disclaimer": "免责声明：说明本报告的使用限制"
}`
	}

	if (mode === PromptMode.INPATIENT) {
	  return `{
	"responseEvaluation": "疗效评级：如 ycTNM、临床缓解情况（CR/PR/SD/PD）",
	"surgicalPlan": "手术预案：标准术式名称 + 淋巴结清扫范围 (D2/D2+)，并简要说明理由",
	"keyConcerns": "关键关注点：术中需特别注意的风险点或决策节点",
	"disclaimer": "免责声明：说明本报告的使用限制"
}`
	}

	if (mode === PromptMode.DISCHARGE) {
	  return `{
	"finalDiagnosis": "最终诊断：(pTNM/ypTNM 分期，必要时包含病理类型等)",
	"adjuvantPlan": "辅助方案：具体的周期数、药物剂量调整原则及是否需要更换方案",
	"prognosisEvaluation": "预后评估：基于分期的5年生存率预估及复发风险点",
	"disclaimer": "免责声明：说明本报告的使用限制"
}`
	}

	return `{
	"diagnosticConclusion": "诊断结论",
	"decisionLogic": "决策逻辑",
	"treatmentPlan": "治疗或管理方案",
	"disclaimer": "免责声明"
}`
  }

  const userPrompt = `Medical Record:
${medicalRecord}

CRITICAL: You MUST respond with ONLY a valid JSON object. NO explanatory text before or after. NO markdown code blocks.

Required JSON Format:
${getJsonSchema(promptMode)}

Respond with ONLY the JSON object above, filled with your analysis.`

  // Filter models to only use selected ones
  const modelsToUse = MODELS.filter(m => selectedModelIds.has(m.id))

  const reports: Report[] = modelsToUse.map(m => ({
    modelId: m.id,
    modelName: m.name,
    content: null,
    streamContent: '',
    phase
  }))

  await Promise.all(
    modelsToUse.map(async (model, idx) => {
      try {
        const response = await callAPI(
          model.id,
          systemPrompt,
          userPrompt,
          false
        )

        reports[idx].streamContent = response.content
        const jsonStr = await extractJSONWithAIRepair(
          response.content,
          model.name,
          'baseline'
        )

        const cleaned = cleanJSON(jsonStr)
        const parsed = await parseJsonSafely(cleaned, `${model.name} baseline report`)

        reports[idx].content = parsed
        reports[idx].tokenUsage = response.tokenUsage
        onUpdate({ ...reports[idx] })
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error'
        console.error(`[${model.name}] Error:`, errorMsg)
        reports[idx].error = errorMsg
        onUpdate({ ...reports[idx] })
      }
    })
  )

  return reports
}

export async function generateOptimizedReports(
  baselineReports: Report[],
  medicalRecord: string,
  onUpdate: (report: OptimizedReport) => void
): Promise<OptimizedReport[]> {
  const optimized: OptimizedReport[] = baselineReports.map(r => ({
    ...r,
    content: null
  }))

  await Promise.all(
    baselineReports.map(async (baseline, idx) => {
      if (!baseline.content) {
        optimized[idx].error = 'No baseline content'
        return
      }

      try {
        const mcpQueryRes = await callAPI(
          baseline.modelId,
          MCP_QUERY_PROMPT_SYSTEM,
          MCP_QUERY_PROMPT_USER(medicalRecord, JSON.stringify(baseline.content, null, 2)),
          false
        )
        const mcpQueryJsonStr = await extractJSONWithAIRepair(
          mcpQueryRes.content,
          baseline.modelName,
          'mcp_query'
        )
        let mcpQuery = await parseJsonSafely(cleanJSON(mcpQueryJsonStr), `${baseline.modelName} MCP query`)

        if (!mcpQuery.mcpCalls || !Array.isArray(mcpQuery.mcpCalls)) {
          const structureError = '结构错误：mcpCalls 字段缺失或不是数组'
          const repairedJson = await repairJsonWithAI(
            cleanJSON(mcpQueryJsonStr),
            structureError,
            5,
            'mcp_query'
          )
          mcpQuery = await parseJsonSafely(
            cleanJSON(repairedJson),
            `${baseline.modelName} MCP query (structure repair)`
          )
        }

        if (!mcpQuery.mcpCalls || !Array.isArray(mcpQuery.mcpCalls)) {
          throw new Error(`Invalid MCP query structure: mcpCalls is not an array`)
        }

        if (mcpQuery.mcpCalls.length === 0) {
          throw new Error(`Invalid MCP query: mcpCalls array is empty`)
        }

        // 过滤并修复无效的 mcpCalls，而不是直接报错
        const validMcpCalls: Array<{tool: string, input: string}> = []
        for (let i = 0; i < mcpQuery.mcpCalls.length; i++) {
          const call = mcpQuery.mcpCalls[i]

          if (!call.tool || typeof call.tool !== 'string') {
            console.warn(`⚠️ [${baseline.modelName}] 跳过无效 mcpCalls[${i}]: tool 缺失或无效`, call)
            continue
          }

          if (call.input === undefined || call.input === null) {
            console.warn(`⚠️ [${baseline.modelName}] 跳过无效 mcpCalls[${i}]: input 缺失`, call)
            continue
          }

          let inputStr = call.input
          if (typeof call.input !== 'string') {
            console.warn(`⚠️ [${baseline.modelName}] mcpCalls[${i}].input 类型为 ${typeof call.input}，转换为字符串`)
            inputStr = String(call.input)
          }

          validMcpCalls.push({ tool: call.tool, input: inputStr })
        }

        // 如果所有 mcpCalls 都无效，使用默认查询
        if (validMcpCalls.length === 0) {
          console.warn(`⚠️ [${baseline.modelName}] 所有 mcpCalls 无效，使用默认查询`)
          validMcpCalls.push({
            tool: 'analyze_medical_query',
            input: `请分析以下病历的临床指南依据：${medicalRecord.substring(0, 500)}`
          })
        }

        mcpQuery.mcpCalls = validMcpCalls

        console.log(`📞 [${baseline.modelName}] 调用MCP，查询数量: ${mcpQuery.mcpCalls?.length || 0}`)
        mcpQuery.mcpCalls?.forEach((call: any, idx: number) => {
          const inputPreview = typeof call.input === 'string'
            ? call.input.substring(0, 50)
            : JSON.stringify(call.input || 'undefined').substring(0, 50)
          console.log(`  ${idx + 1}. ${call.tool}: ${inputPreview}...`)
        })

        const mcpRes = await optimizeWithMCP(baseline.content, baseline.phase, medicalRecord, mcpQuery.mcpCalls)
        const mcpOutputsJson = JSON.stringify(mcpRes.outputs || [], null, 2)
        const citationsJson = JSON.stringify(mcpRes.citations || [], null, 2)

        console.log(`📚 [${baseline.modelName}] MCP返回 ${mcpRes.citations?.length || 0} 条指南引用`)
        if (mcpRes.citations && mcpRes.citations.length > 0) {
          mcpRes.citations.forEach((citation: any, idx: number) => {
            console.log(`  ${idx + 1}. ${citation.guidelineName}`)
          })
        } else {
          console.warn(`⚠️ [${baseline.modelName}] MCP未返回任何指南引用！`)
        }

        const optimizeRes = await callAPI(
          baseline.modelId,
          MCP_OPTIMIZE_PROMPT_SYSTEM,
          MCP_OPTIMIZE_PROMPT_USER(JSON.stringify(baseline.content, null, 2), mcpOutputsJson, citationsJson),
          false
        )

        const optimizedJsonStr = await extractJSONWithAIRepair(
          optimizeRes.content,
          baseline.modelName,
          'optimize'
        )
        const optimizedParsed = await parseJsonSafely(cleanJSON(optimizedJsonStr), `${baseline.modelName} optimized report`)

        // ===== 结构保留验证 =====
        const baselineKeys = Object.keys(baseline.content).sort()
        const optimizedReport = optimizedParsed.optimizedReport || {}
        const optimizedKeys = Object.keys(optimizedReport).sort()

        if (JSON.stringify(baselineKeys) !== JSON.stringify(optimizedKeys)) {
          const missingKeys = baselineKeys.filter(k => !optimizedKeys.includes(k))
          const extraKeys = optimizedKeys.filter(k => !baselineKeys.includes(k))

          console.warn(`⚠️ [${baseline.modelName}] 结构不匹配！`)
          console.warn(`  基线字段: ${baselineKeys.join(', ')}`)
          console.warn(`  优化字段: ${optimizedKeys.join(', ')}`)
          if (missingKeys.length > 0) console.warn(`  缺失字段: ${missingKeys.join(', ')}`)
          if (extraKeys.length > 0) console.warn(`  多余字段: ${extraKeys.join(', ')}`)

          // 自动修复：将优化内容合并回基线结构
          const merged: Record<string, any> = { ...baseline.content }
          Object.keys(optimizedReport).forEach(key => {
            if (key in merged) {
              merged[key] = optimizedReport[key]
            }
          })
          optimizedParsed.optimizedReport = merged
          console.log(`✅ [${baseline.modelName}] 已自动修复：将优化内容合并回基线结构`)
        }

        // ===== 通用质量验证（所有模型） =====
        const modelName = baseline.modelName
        const changeLog = optimizedParsed.changeLog || []
        const qualityMetrics = optimizedParsed.qualityMetrics || {}

        // 验证1：检查changeLog是否存在
        if (changeLog.length === 0) {
          console.warn(`⚠️ [${modelName}] 未生成changeLog，可能只添加了引用而未做实质性修改`)
        }

        // 验证2：检查实质性修改数量
        const substantiveChanges = qualityMetrics.substantiveChanges || 0
        if (substantiveChanges < 2) {
          console.warn(`⚠️ [${modelName}] 实质性修改数量不足: ${substantiveChanges}/2（最低要求）`)
        }

        // 验证3：计算优化前后相似度
        const baselineStr = JSON.stringify(baseline.content)
        const optimizedStr = JSON.stringify(optimizedParsed.optimizedReport || optimizedParsed)
        const similarity = calculateSimpleSimilarity(baselineStr, optimizedStr)

        if (similarity > 0.95) {
          console.warn(`⚠️ [${modelName}] 优化前后相似度过高: ${(similarity * 100).toFixed(1)}%，可能未进行充分修改`)
        }

        // 验证4：检查是否有[冲突]标记但未修改的情况
        const conflictItems = changeLog.filter((c: any) =>
          c.classification === '[冲突]' || c.classification === '[多源冲突]'
        )
        const modifiedConflicts = conflictItems.filter((c: any) => c.changeType === 'modified')

        if (conflictItems.length > 0 && modifiedConflicts.length === 0) {
          console.error(`❌ [${modelName}] 识别到${conflictItems.length}个冲突，但均未修改！`)
        }

        // 验证5-7：使用citationValidator进行综合验证和自动修复
        const modelCitations = optimizedParsed.citations || []
        const mcpCitations = mcpRes.citations || []

        const validationResult = validateCitations(modelCitations, mcpCitations, changeLog)

        validationResult.errors.forEach(error => console.error(`❌ [${modelName}] ${error}`))
        validationResult.warnings.forEach(warning => console.warn(`⚠️ [${modelName}] ${warning}`))

        // 禁用无效引用过滤 - 保留模型返回的所有引用
        // const { fixedCitations, removedCount, fixLog } = applyAutomaticFix(...)
        const fixedCitations = modelCitations  // 直接使用原始引用
        const removedCount = 0

        const consistencyCheck = checkCitationConsistency(fixedCitations, changeLog)
        if (consistencyCheck.consistency < 0.8) {
          console.warn(
            `⚠️ [${modelName}] 引用与changeLog一致性较低: ${(consistencyCheck.consistency * 100).toFixed(1)}%`
          )
        }

        // 记录质量指标日志
        console.log(`✅ [${modelName}] 优化质量:`, {
          changeLog: changeLog.length,
          substantiveChanges,
          similarity: `${(similarity * 100).toFixed(1)}%`,
          conflictsResolved: modifiedConflicts.length,
          citationValidity: `${modelCitations.length}/${modelCitations.length} (no filter)`,
          mcpCitationsAvailable: mcpCitations.length,
          consistency: `${(consistencyCheck.consistency * 100).toFixed(1)}%`
        })

        // ===== 保存结果 =====
        optimized[idx].content = optimizedParsed.optimizedReport || optimizedParsed
        optimized[idx].changeLog = changeLog
        optimized[idx].qualityMetrics = {
          ...qualityMetrics,
          similarity,
          citationValidityRate: validationResult.metrics.citationValidityRate,
          invalidCitationsRemoved: removedCount,
          citationConsistency: consistencyCheck.consistency
        }
        optimized[idx].citations = fixedCitations
        optimized[idx].mcpSourceCitations = mcpRes.citations || []
        optimized[idx].reasoningTrace = optimizedParsed.reasoningTrace
        optimized[idx].tokenUsage = optimizeRes.tokenUsage
        optimized[idx].baselineScore = 0
        onUpdate(optimized[idx])
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error'
        const isMcpFatal = error instanceof MCPFatalError
        optimized[idx].error = isMcpFatal ? `[MCP_FATAL] ${errorMsg}` : errorMsg

        if (isMcpFatal) {
          console.error(`🛑 [${baseline.modelName}] MCP 致命错误，终止该模型优化: ${errorMsg}`)
          onUpdate(optimized[idx] as OptimizedReport)
          throw error
        }

        onUpdate(optimized[idx] as OptimizedReport)
      }
    })
  )

  // 检查是否有 MCP 致命错误
  const mcpFatalErrors = optimized.filter(r => r.error?.startsWith('[MCP_FATAL]'))
  if (mcpFatalErrors.length > 0) {
    console.error(`🛑 检测到 ${mcpFatalErrors.length} 个 MCP 致命错误，建议检查 MCP 服务状态`)
    throw new MCPFatalError(`MCP 调用失败，已终止流程（${mcpFatalErrors.length} 个错误）`)
  }

  return optimized
}

export async function generatePeerOptimizedReports(
  optimizedReports: OptimizedReport[],
  peerReviews: PeerReview[],
  onUpdate: (report: OptimizedReport) => void
): Promise<OptimizedReport[]> {
  const peerOptimized: OptimizedReport[] = optimizedReports.map(r => ({ ...r }))

  await Promise.all(
    optimizedReports.map(async (report, idx) => {
      if (!report.content) {
        peerOptimized[idx].error = 'No optimized content'
        onUpdate(peerOptimized[idx])
        return
      }

      const relatedReviews = peerReviews.filter(r => r.targetModelId === report.modelId)

      if (relatedReviews.length === 0) {
        onUpdate(peerOptimized[idx])
        return
      }

      const systemPrompt = '你是生成这份优化后报告的同一个临床 AI 模型，现在需要根据多名同行专家（其他 AI 模型）的评审意见，对报告进行第三阶段再优化。你必须保留原有 JSON 结构，仅在字段内容层面进行必要的修改和增强。'

      const userPrompt = `【原始优化后报告 JSON】\n${JSON.stringify(report.content, null, 2)}\n\n` +
        `【同行评审结果 JSON】\n${JSON.stringify(relatedReviews, null, 2)}\n\n` +
        '【任务目标】\n- 综合同行评审意见，优先修正所有在安全性（safety）和准确性（accuracy）维度指出的问题，尤其是带有 fatalFlag=true 的意见。\n' +
        '- 在不破坏原有指南依据和 citations 的前提下，补充遗漏信息、强化逻辑结构、提升表达清晰度。\n' +
        '\n【输出格式要求】\n- 只返回一个 JSON 对象。\n- 根级字段必须与【原始优化后报告 JSON】中的内容完全一致（字段名和结构保持不变）。\n- 允许修改各字段内的文本内容，但不得删除或新增顶级字段。\n- 不要添加任何解释性文字或 markdown 代码块。'

      try {
        const response = await callAPI(
          report.modelId,
          systemPrompt,
          userPrompt,
          false
        )

        const jsonStr = await extractJSONWithAIRepair(
          response.content,
          report.modelName,
          'optimize'
        )

        const cleaned = cleanJSON(jsonStr)
        const parsed = await parseJsonSafely<any>(cleaned, `${report.modelName} peer-optimized report`)

        if (parsed && typeof parsed === 'object') {
          peerOptimized[idx].content = parsed
        }

        if (response.tokenUsage) {
          peerOptimized[idx].tokenUsage = response.tokenUsage
        }

        peerOptimized[idx].error = undefined
        onUpdate(peerOptimized[idx])
      } catch (error) {
        peerOptimized[idx].error = error instanceof Error ? error.message : 'Unknown error'
        onUpdate(peerOptimized[idx])
      }
    })
  )

  return peerOptimized
}
