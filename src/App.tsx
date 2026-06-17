import React, { useState } from 'react'
import { generateBaselineReports, generateOptimizedReports, generatePeerOptimizedReports } from './services/reportGenerator'
import { generateBaselineReportMd, generateSelfOptimizedReportMd, generateScoringMatrixMd, generatePeerReviewDetailsMd, exportToFile } from './services/markdownExport'
import { ClinicalPhase, PromptMode } from './types/phase'
import { PROMPT_MODE_CONFIGS } from './utils/prompts'
import { MODELS } from './utils/models'
import { runPeerReview } from './services/peerReview'
import type { FinalReportData } from './services/peerReview'
import type { PeerReview } from './types/scoring'

interface UiReport {
  modelId: string
  modelName: string
  streamContent: string
  content: any
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }
  error?: string
}

export default function App() {
  const [medicalRecord, setMedicalRecord] = useState('')
  const [selectedPromptMode, setSelectedPromptMode] = useState<PromptMode>(PromptMode.OUTPATIENT)
  const [currentPhase, setCurrentPhase] = useState<ClinicalPhase>(ClinicalPhase.OUTPATIENT)
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set(MODELS.map(m => m.id)))

  const [isLoading, setIsLoading] = useState(false)
  const [loadingMessage, setLoadingMessage] = useState('')
  const [progress, setProgress] = useState(0)

  const [baselineReports, setBaselineReports] = useState<UiReport[]>([])
  const [optimizedReports, setOptimizedReports] = useState<any[]>([])
  const [peerOptimizedReports, setPeerOptimizedReports] = useState<any[]>([])
  const [peerReviews, setPeerReviews] = useState<PeerReview[]>([])
  const [averageScores, setAverageScores] = useState<Record<string, number>>({})

  const handleGenerate = async () => {
    if (!medicalRecord.trim()) {
      alert('请输入病历内容')
      return
    }

    setIsLoading(true)
    setLoadingMessage('正在生成基线报告...')
    setProgress(0)
    setBaselineReports([])
    setOptimizedReports([])
    setPeerOptimizedReports([])
    setPeerReviews([])
    setAverageScores({})
    

    try {
      // Phase 1a: Generate baseline reports
      const phaseForPromptMode = selectedPromptMode.includes('outpatient')
        ? ClinicalPhase.OUTPATIENT
        : selectedPromptMode.includes('inpatient')
          ? ClinicalPhase.INPATIENT
          : ClinicalPhase.DISCHARGE

      const baseline = await generateBaselineReports(
        medicalRecord,
        phaseForPromptMode,
        selectedPromptMode,
        selectedModels,
        (report) => {
          setBaselineReports(prev => {
            const existing = prev.find(r => r.modelId === report.modelId)
            if (existing) {
              return prev.map(r => r.modelId === report.modelId ? report as UiReport : r)
            }
            return [...prev, report as UiReport]
          })
          setProgress(prev => Math.min(prev + 2, 30))
        }
      )

      setLoadingMessage('正在进行自我优化...')
      setProgress(35)

      // Phase 1b: Generate optimized reports
      const optimized = await generateOptimizedReports(baseline, medicalRecord, (report) => {
        setOptimizedReports(prev => {
          const existing = prev.find((r: any) => r.modelId === report.modelId)
          if (existing) {
            return prev.map((r: any) => r.modelId === report.modelId ? report : r)
          }
          return [...prev, report]
        })
      })

      setOptimizedReports(optimized as any[])

      setLoadingMessage('正在进行同行评审...')
      setProgress(60)

      const peerReviewsResult = await runPeerReview(optimized as any, (review, index) => {
        setPeerReviews(prev => {
          const next = [...prev]
          next[index] = review
          return next
        })
        setProgress(prev => Math.min(prev + 1, 80))
      })

      const scoreSum: Record<string, { sum: number; count: number }> = {}
      peerReviewsResult.forEach(review => {
        const id = review.targetModelId
        if (!scoreSum[id]) {
          scoreSum[id] = { sum: 0, count: 0 }
        }
        scoreSum[id].sum += review.weightedOverallScore
        scoreSum[id].count++
      })

      const avg: Record<string, number> = {}
      Object.entries(scoreSum).forEach(([modelId, { sum, count }]) => {
        avg[modelId] = count > 0 ? sum / count : 0
      })
      setAverageScores(avg)

      setLoadingMessage('正在根据同行评审进行第三阶段再优化...')
      setProgress(85)

      const peerOptimized = await generatePeerOptimizedReports(optimized as any, peerReviewsResult, (report) => {
        setPeerOptimizedReports(prev => {
          const idx = prev.findIndex((r: any) => r.modelId === report.modelId)
          if (idx >= 0) {
            const next = [...prev]
            next[idx] = report
            return next
          }
          return [...prev, report]
        })
        setProgress(prev => Math.min(prev + 1, 95))
      })

      setPeerOptimizedReports(peerOptimized as any[])

      setLoadingMessage('完成！')
      setProgress(100)
      setTimeout(() => setIsLoading(false), 500)

    } catch (error) {
      console.error('报告生成失败:', error)
      alert('报告生成失败: ' + (error as Error).message)
      setIsLoading(false)
    }
  }

  const handleExport = () => {
    if (baselineReports.length === 0) {
      alert('没有可导出的报告')
      return
    }

    const today = new Date().toLocaleDateString('zh-CN')
    let md = `# AI 医疗咨询研究报告\n\n`
    md += `**生成时间**: ${today}\n\n`
    md += `**提示词模式**: ${PROMPT_MODE_CONFIGS[selectedPromptMode].name}\n\n`
    md += `---\n\n`

    md += `## 第一部分：基线报告\n\n`
    baselineReports.forEach((report, idx) => {
      md += generateBaselineReportMd(report as any, idx)
    })

    if (optimizedReports.length > 0) {
      md += `\n\n## 第二部分：自我优化报告\n\n`

      optimizedReports.forEach((report, idx) => {
        md += generateSelfOptimizedReportMd(report as any, idx)

        if (report.changeLog && report.changeLog.length > 0) {
          md += `\n### 📋 变更记录 (Change Log)\n\n`
          md += `| # | 字段 | 类型 | 分类 | 证据等级 |\n`
          md += `|---|------|------|------|----------|\n`

          report.changeLog.forEach((change: any, cIdx: number) => {
            md += `| ${cIdx + 1} | ${change.field} | ${change.changeType} | ${change.classification} | ${change.evidenceTier || 'N/A'} |\n`
          })

          md += `\n**变更详情：**\n\n`
          report.changeLog.forEach((change: any, cIdx: number) => {
            md += `${cIdx + 1}. **${change.field}** (${change.classification})\n`
            if (change.changeType === 'modified') {
              md += `   - **原始内容**: ${change.original}\n`
              md += `   - **优化内容**: ${change.optimized}\n`
            }
            md += `   - **指南依据**: ${change.guidelineEvidence}\n`
            if (change.evidenceTier) {
              md += `   - **证据等级**: ${change.evidenceTier}\n`
            }
            if (change.resolutionRule) {
              md += `   - **应用规则**: ${change.resolutionRule}\n`
            }
            md += `\n`
          })
        }

        if (report.qualityMetrics) {
          md += `\n### 📊 质量指标\n\n`
          const metrics = report.qualityMetrics
          md += `- **实质性修改**: ${metrics.substantiveChanges || 0} 处\n`
          md += `- **引用指南**: ${metrics.guidelinesCited || 0} 条\n`
          md += `- **保留声明**: ${metrics.retainedStatements || 0} 处\n`
          if (metrics.conflictsResolved) {
            md += `- **解决冲突**: ${metrics.conflictsResolved} 个\n`
          }
          if (metrics.clinicalImpact) {
            md += `- **临床影响**: ${metrics.clinicalImpact}\n`
          }
          if (metrics.similarity !== undefined) {
            md += `- **相似度**: ${(metrics.similarity * 100).toFixed(1)}%\n`
          }
          md += `\n`
        }
      })
    }

    if (peerOptimizedReports.length > 0) {
      md += `\n\n## 第三部分：同行评审后再优化报告\n\n`

      peerOptimizedReports.forEach((report, idx) => {
        md += generateSelfOptimizedReportMd(report as any, idx)
      })
    }

    if (peerReviews.length > 0) {
      const scoreSum: Record<string, { sum: number; count: number }> = {}
      peerReviews.forEach(review => {
        const id = review.targetModelId
        if (!scoreSum[id]) {
          scoreSum[id] = { sum: 0, count: 0 }
        }
        scoreSum[id].sum += review.weightedOverallScore
        scoreSum[id].count++
      })

      const exportAverage: Record<string, number> = {}
      Object.entries(scoreSum).forEach(([modelId, { sum, count }]) => {
        exportAverage[modelId] = count > 0 ? sum / count : 0
      })

      const finalData: FinalReportData = {
        winningReport: baselineReports[0] as any,
        allReports: baselineReports as any,
        peerReviews,
        selfOptimizedReports: optimizedReports as any,
        averageScores: Object.keys(averageScores).length > 0 ? averageScores : exportAverage
      }

      md += `\n`
      md += generateScoringMatrixMd(finalData)
      md += `\n`
      md += generatePeerReviewDetailsMd(peerReviews)
    }

    md += `\n\n## 附录：Token使用统计\n\n`
    md += `| 模型 | 输入 | 输出 | 总计 |\n`
    md += `|------|------|------|------|\n`
    baselineReports.forEach(report => {
      if (report.tokenUsage) {
        md += `| ${report.modelName} | ${report.tokenUsage.inputTokens.toLocaleString()} | ${report.tokenUsage.outputTokens.toLocaleString()} | ${report.tokenUsage.totalTokens.toLocaleString()} |\n`
      }
    })

    md += `\n---\n\n`
    md += `*本报告由AI生成，仅供研究参考，不构成医疗建议。*\n`
    md += `*所有临床决策必须由有资质的医疗专业人员做出。*`

    exportToFile(md, `医疗咨询研究报告-${Date.now()}`, 'md')
    alert('✅ 报告已成功导出为Markdown格式！')
  }

  const toggleModel = (modelId: string) => {
    setSelectedModels(prev => {
      const next = new Set(prev)
      if (next.has(modelId)) {
        next.delete(modelId)
      } else {
        next.add(modelId)
      }
      return next
    })
  }

  const calculateTotalTokens = () => {
    let total = 0
    baselineReports.forEach(r => {
      if (r.tokenUsage) total += r.tokenUsage.totalTokens
    })
    return total.toLocaleString()
  }

  

  return (
    <div className="app">
      <div className="header">
        <h1>AI 医疗咨询研究面板</h1>
        <p>多模型医疗咨询报告生成与同行评审系统</p>
      </div>

      <div className="control-panel">
        <div className="control-card">
          <h3>病历输入</h3>
          <div className="input-group">
            <label htmlFor="medical-record">输入病历内容</label>
            <textarea
              id="medical-record"
              placeholder="请输入详细的病历信息..."
              value={medicalRecord}
              onChange={(e) => setMedicalRecord(e.target.value)}
              rows={6}
            />
          </div>
        </div>

        <div className="control-card">
          <h3>提示词模式选择（3种）</h3>
          <div className="prompt-mode-grid">
            {Object.entries(PROMPT_MODE_CONFIGS).map(([mode, config]) => (
              <div
                key={mode}
                className={`prompt-mode-option ${selectedPromptMode === mode ? 'selected' : ''}`}
                onClick={() => setSelectedPromptMode(mode as PromptMode)}
              >
                <h4>{config.name}</h4>
                <p>{config.description}</p>
              </div>
            ))}
          </div>
        </div>

        

        <div className="control-card">
          <h3>选择AI模型</h3>
          <div className="model-grid">
            {MODELS.map(model => (
              <div key={model.id} className="model-checkbox">
                <input
                  type="checkbox"
                  id={model.id}
                  checked={selectedModels.has(model.id)}
                  onChange={() => toggleModel(model.id)}
                />
                <label htmlFor={model.id}>{model.name}</label>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
        <button
          className="btn btn-primary"
          onClick={handleGenerate}
          disabled={isLoading}
          style={{ fontSize: '1.1rem', padding: '1rem 2rem' }}
        >
          {isLoading ? (
            <>
              <span className="loading-spinner"></span>
              {loadingMessage}
            </>
          ) : (
            '生成完整研究报告'
          )}
        </button>
      </div>

      {isLoading && (
        <div className="loading">
          <div className="progress-bar" style={{ marginBottom: '1rem' }}>
            <div className="progress-fill" style={{ width: `${progress}%` }}></div>
          </div>
        </div>
      )}

      {baselineReports.length > 0 && (
        <>
          <div style={{ background: '#fef3c7', border: '1px solid #fbbf24', padding: '1rem', borderRadius: '8px', marginBottom: '2rem' }}>
            <strong style={{ color: '#92400e' }}>Token 统计：</strong>
            <span style={{ color: '#92400e' }}>总计 {calculateTotalTokens()} tokens</span>
          </div>

          <div style={{
            textAlign: 'center',
            marginBottom: '2rem',
            padding: '1rem',
            background: 'rgba(59, 130, 246, 0.1)',
            borderRadius: '8px',
            border: '1px solid rgba(59, 130, 246, 0.3)'
          }}>
            <button
              className="btn btn-secondary"
              onClick={handleExport}
              style={{
                fontSize: '1rem',
                padding: '0.75rem 1.5rem',
                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                border: 'none',
                color: 'white',
                cursor: 'pointer',
                borderRadius: '6px',
                fontWeight: 'bold'
              }}
            >
              📥 导出完整研究报告（Markdown）
            </button>
            <p style={{
              marginTop: '0.5rem',
              fontSize: '0.875rem',
              color: '#9ca3af'
            }}>
              包含三阶段报告、变更记录、质量指标和评分矩阵
            </p>
          </div>

          <h2 style={{ color: 'white', marginBottom: '1rem', textAlign: 'center' }}>1. 基线报告</h2>
          <div className="reports-grid">
            {baselineReports.map((report, idx) => (
              <div key={report.modelId} className="report-card">
                <h3>
                  {idx + 1}. {selectedPromptMode === PromptMode.OUTPATIENT
                    ? `门诊综合评估与治疗计划报告 - ${report.modelName}`
                    : `${report.modelName} 基线报告`}
                </h3>
                {report.error ? (
                  <div className="error-message">错误：{report.error}</div>
                ) : (
                  <div className="report-content">
                    {report.streamContent.split('\n').map((line, i) => (
                      <p key={i}>{line}</p>
                    ))}
                  </div>
                )}
                {report.tokenUsage && (
                  <div className="token-usage">
                    <small>
                      输入: {report.tokenUsage.inputTokens.toLocaleString()} |
                      输出: {report.tokenUsage.outputTokens.toLocaleString()} |
                      总计: {report.tokenUsage.totalTokens.toLocaleString()}
                    </small>
                  </div>
                )}
              </div>
            ))}
          </div>

          <h2 style={{ color: 'white', margin: '2rem 0 1rem', textAlign: 'center' }}>2. 自我优化报告</h2>
          <div className="reports-grid">
            {optimizedReports.map((report: any, idx: number) => (
              <div key={report.modelId} className="report-card">
                <h3>{idx + 1}. {report.modelName}（自我优化）</h3>
                {report.error ? (
                  <div className="error-message">错误：{report.error}</div>
                ) : (
                  <div className="report-content">
                    {JSON.stringify(report.content, null, 2).split('\n').map((line: string, i: number) => (
                      <p key={i}>{line}</p>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {peerOptimizedReports.length > 0 && (
            <>
              <h2 style={{ color: 'white', margin: '2rem 0 1rem', textAlign: 'center' }}>3. 同行评审后再优化报告</h2>
              <div className="reports-grid">
                {peerOptimizedReports.map((report: any, idx: number) => (
                  <div key={report.modelId} className="report-card">
                    <h3>{idx + 1}. {report.modelName}（第三阶段：同行评审后再优化）</h3>
                    {report.error ? (
                      <div className="error-message">错误：{report.error}</div>
                    ) : (
                      <div className="report-content">
                        {JSON.stringify(report.content, null, 2).split('\n').map((line: string, i: number) => (
                          <p key={i}>{line}</p>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          <div style={{ textAlign: 'center', marginTop: '2rem' }}>
            <button className="btn btn-warning" onClick={handleExport}>
              📄 导出Markdown报告
            </button>
            <p style={{ color: 'white', marginTop: '0.5rem', fontSize: '0.9rem' }}>
              导出包含三阶段报告和评分矩阵的Markdown文件
            </p>
          </div>
        </>
      )}

      
    </div>
  )
}
