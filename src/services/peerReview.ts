// Peer Review Service
// Phase 2: Models evaluate each other's reports

import { MODELS } from '../utils/models'
import { type Report } from '../types/report'
import { PEER_REVIEW_PROMPT } from '../utils/prompts'
import { callAPI, cleanJSON, extractJSONWithAIRepair, parseJsonSafely } from './reportGenerator'
import { type PeerReview, type DimensionScores, type ReviewJustification } from '../types/scoring'

async function evaluateReport(
  evaluatorModelId: string,
  report: Report
): Promise<PeerReview> {
  const model = MODELS.find(m => m.id === evaluatorModelId)

  if (!report.content) {
    throw new Error('No content to evaluate')
  }

  const userPrompt = `${PEER_REVIEW_PROMPT}

[优化后报告 JSON]
${JSON.stringify(report.content, null, 2)}

[引用信息（MCP 返回的指南证据）]
${JSON.stringify((report as any).citations || [], null, 2)}`

  const response = await callAPI(
    evaluatorModelId,
    '你是一名临床专家，负责根据给定的指南证据对下面的报告进行同行评审并给出 4 维打分。',
    userPrompt,
    false
  )

  const evaluatorName = model?.name || evaluatorModelId
  const jsonStr = await extractJSONWithAIRepair(
    response.content,
    evaluatorName,
    'baseline'
  )

  const cleaned = cleanJSON(jsonStr)
  const parsed = await parseJsonSafely(cleaned, `${evaluatorName} peer review`)

  const normalizeScore = (raw: any): number => {
    let value = 0
    if (typeof raw === 'number') {
      value = raw
    } else if (raw && typeof raw.score === 'number') {
      value = raw.score
    } else if (typeof raw === 'string') {
      const n = parseFloat(raw)
      if (!Number.isNaN(n)) value = n
    } else if (raw && typeof raw.score === 'string') {
      const n = parseFloat(raw.score)
      if (!Number.isNaN(n)) value = n
    }
    if (!Number.isFinite(value)) value = 1
    if (value < 1) value = 1
    if (value > 5) value = 5
    return value
  }

  const rawScores = parsed.scores || {}

  const scores: DimensionScores = {
    accuracy: normalizeScore(rawScores.accuracy),
    completeness: normalizeScore(rawScores.completeness),
    safety: normalizeScore(rawScores.safety),
    clarity: normalizeScore(rawScores.clarity)
  }

  const weightedOverallScore =
    scores.accuracy * 0.5 +
    scores.completeness * 0.3 +
    scores.safety * 0.1 +
    scores.clarity * 0.1

  const justification: ReviewJustification = {
    accuracy: parsed.justification?.accuracy || '',
    completeness: parsed.justification?.completeness || '',
    safety: parsed.justification?.safety || '',
    clarity: parsed.justification?.clarity || ''
  }

  const fatalFlag = Boolean(rawScores?.safety?.fatalFlag)

  return {
    targetModelId: report.modelId,
    targetModelName: report.modelName,
    evaluatorModelId,
    evaluatorModelName: model?.name || evaluatorModelId,
    scores,
    weightedOverallScore,
    justification,
    fatalFlag,
    tokenUsage: response.tokenUsage
  }
}

export async function runPeerReview(
  reports: Report[],
  onUpdate: (review: PeerReview, index: number) => void
): Promise<PeerReview[]> {
  const reviews: PeerReview[] = []
  let completed = 0

  // Each model evaluates each report (5x5 matrix)
  const evaluationPromises: Promise<void>[] = []

  const validReports = reports.filter(report => report.content)

  validReports.forEach((report, reportIdx) => {
    MODELS.forEach(async (model, modelIdx) => {
      evaluationPromises.push(
        (async () => {
          try {
            const review = await evaluateReport(model.id, report)
            reviews[reportIdx * MODELS.length + modelIdx] = review
            onUpdate(review, completed++)
          } catch (error) {
            console.error(`Failed to evaluate ${report.modelName} by ${model.name}:`, error)
          }
        })()
      )
    })
  })

  await Promise.all(evaluationPromises)

  return reviews
}

export interface FinalReportData {
  winningReport: Report;
  allReports: Report[];
  peerReviews: PeerReview[];
  selfOptimizedReports: Report[];
  averageScores: Record<string, number>;
}

export async function consolidateResults(
  baselineReports: Report[],
  selfOptimizedReports: Report[],
  peerReviews: PeerReview[]
): Promise<FinalReportData> {
  // Calculate average scores
  const scoreSum: Record<string, { sum: number; count: number }> = {}

  peerReviews.forEach(review => {
    const targetId = review.targetModelId
    if (!scoreSum[targetId]) {
      scoreSum[targetId] = { sum: 0, count: 0 }
    }
    scoreSum[targetId].sum += review.weightedOverallScore
    scoreSum[targetId].count++
  })

  const averageScores = Object.fromEntries(
    Object.entries(scoreSum).map(([modelId, { sum, count }]) => [
      modelId,
      count > 0 ? sum / count : 0
    ])
  )

  // Find winner
  const winnerId = Object.entries(averageScores).reduce((winner, [modelId, score]) =>
    score > averageScores[winner] ? modelId : winner,
    Object.keys(averageScores)[0] || ''
  )

  const winningReport = baselineReports.find(r => r.modelId === winnerId) || baselineReports[0]

  return {
    winningReport,
    allReports: baselineReports,
    peerReviews,
    selfOptimizedReports,
    averageScores
  }
}
