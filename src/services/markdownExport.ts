// Markdown Export Service
// Converts reports to Markdown format

import type { Report, OptimizedReport } from '../types/report'
import type { FinalReportData } from '../services/peerReview'
import { MODELS } from '../utils/models'
import { ClinicalPhase } from '../types/phase'

function formatReportSection(title: string, content: string, level: number = 2): string {
  const heading = '#'.repeat(level)
  return `${heading} ${title}\n\n${content}\n\n`
}

function formatReasoning(content: any): string {
  let md = ''

  md += formatReportSection('Key Questions', '', 3)
  content.reasoningProcess.keyQuestions.forEach((q: any, idx: number) => {
    md += `${idx + 1}. **${q.question}**\n`
    md += `   - Evidence: ${q.evidence}\n`
    md += `   - Analysis: ${q.analysis}\n\n`
  })

  md += formatReportSection('Differential Diagnosis', '', 3)
  content.reasoningProcess.differentialDiagnosis.forEach((d: any, idx: number) => {
    md += `${idx + 1}. **${d.diagnosis}** (${d.likelihood})\n`
    md += `   - Supporting: ${d.supportingEvidence}\n`
    md += `   - Opposing: ${d.opposingEvidence}\n\n`
  })

  return md
}

function formatIntegrativeDischargeReport(content: any): string {
  let md = ''

  if (Array.isArray(content.treatmentTimeline)) {
    md += formatReportSection('治疗时间线 (Treatment Timeline)', '', 3)
    content.treatmentTimeline.forEach((item: any, idx: number) => {
      md += `${idx + 1}. **${item.phase || item.date || '阶段'}**\n`
      if (item.treatment) md += `   - 治疗: ${item.treatment}\n`
      if (item.outcome) md += `   - 结果: ${item.outcome}\n`
      if (item.notes) md += `   - 备注: ${item.notes}\n`
      md += '\n'
    })
  }

  if (content.pathologyAssessment) {
    md += formatReportSection('病理评估 (Pathology Assessment)', '', 3)
    const pa = content.pathologyAssessment
    if (pa.diagnosis) md += `- **诊断**: ${pa.diagnosis}\n`
    if (pa.stage) md += `- **分期**: ${pa.stage}\n`
    if (pa.grade) md += `- **分级**: ${pa.grade}\n`
    if (pa.margins) md += `- **切缘**: ${pa.margins}\n`
    if (pa.lymphNodes) md += `- **淋巴结**: ${pa.lymphNodes}\n`
    if (pa.molecularMarkers) md += `- **分子标记**: ${pa.molecularMarkers}\n`
    md += '\n'
  }

  if (content.adjuvantTherapyPlan) {
    md += formatReportSection('辅助治疗计划 (Adjuvant Therapy Plan)', '', 3)
    const atp = content.adjuvantTherapyPlan
    if (atp.chemotherapy) md += `- **化疗**: ${atp.chemotherapy}\n`
    if (atp.radiotherapy) md += `- **放疗**: ${atp.radiotherapy}\n`
    if (atp.targetedTherapy) md += `- **靶向治疗**: ${atp.targetedTherapy}\n`
    if (atp.immunotherapy) md += `- **免疫治疗**: ${atp.immunotherapy}\n`
    if (atp.schedule) md += `- **时间安排**: ${atp.schedule}\n`
    md += '\n'
  }

  if (content.nutritionRehabPlan) {
    md += formatReportSection('营养康复计划 (Nutrition & Rehab Plan)', '', 3)
    const nrp = content.nutritionRehabPlan
    if (nrp.diet) md += `- **饮食**: ${nrp.diet}\n`
    if (nrp.supplements) md += `- **补充剂**: ${nrp.supplements}\n`
    if (nrp.exercise) md += `- **运动**: ${nrp.exercise}\n`
    if (nrp.rehabilitation) md += `- **康复**: ${nrp.rehabilitation}\n`
    md += '\n'
  }

  if (content.complicationManagement) {
    md += formatReportSection('并发症管理 (Complication Management)', '', 3)
    const cm = content.complicationManagement
    if (cm.current) md += `- **当前并发症**: ${cm.current}\n`
    if (cm.prevention) md += `- **预防措施**: ${cm.prevention}\n`
    if (cm.monitoring) md += `- **监测要点**: ${cm.monitoring}\n`
    md += '\n'
  }

  if (content.followUpPlan) {
    md += formatReportSection('随访计划 (Follow-up Plan)', '', 3)
    const fp = content.followUpPlan
    if (fp.schedule) md += `- **随访时间表**: ${fp.schedule}\n`
    if (fp.tests) md += `- **检查项目**: ${fp.tests}\n`
    if (fp.imaging) md += `- **影像检查**: ${fp.imaging}\n`
    if (fp.markers) md += `- **肿瘤标志物**: ${fp.markers}\n`
    md += '\n'
  }

  if (Array.isArray(content.patientEducation)) {
    md += formatReportSection('患者教育 (Patient Education)', '', 3)
    content.patientEducation.forEach((item: string, idx: number) => {
      md += `${idx + 1}. ${item}\n`
    })
    md += '\n'
  }

  if (content.disclaimer) {
    md += formatReportSection('免责声明 (Disclaimer)', content.disclaimer, 3)
  }

  return md
}

export function generateBaselineReportMd(report: Report, index: number): string {
  if (!report.content) return ''

  const content = report.content as any

  const isOutpatient = report.phase === ClinicalPhase.OUTPATIENT
  const title = isOutpatient
    ? `${index + 1}. 门诊综合评估与治疗计划报告 - ${report.modelName}`
    : `${index + 1}. ${report.modelName} 基线报告`

  let md = formatReportSection(title, '', 2)

  // Check for Integrative Discharge format
  if (content.treatmentTimeline || content.pathologyAssessment || content.adjuvantTherapyPlan) {
    md += formatIntegrativeDischargeReport(content)
  } else {
    if (report.phase === ClinicalPhase.OUTPATIENT) {
      if (content.diagnosticConclusion) {
        md += formatReportSection('诊断结论', content.diagnosticConclusion, 3)
      }

      if (content.decisionLogic) {
        md += formatReportSection('决策逻辑', content.decisionLogic, 3)
      }

      if (content.treatmentPlan) {
        md += formatReportSection('拟定医嘱', content.treatmentPlan, 3)
      }

      if (content.disclaimer) {
        md += formatReportSection('免责声明', content.disclaimer, 3)
      }
    } else if (report.phase === ClinicalPhase.INPATIENT) {
      if (content.responseEvaluation) {
        md += formatReportSection('疗效评级', content.responseEvaluation, 3)
      }

      if (content.surgicalPlan) {
        md += formatReportSection('手术预案', content.surgicalPlan, 3)
      }

      if (content.keyConcerns) {
        md += formatReportSection('关键关注点', content.keyConcerns, 3)
      }

      if (content.disclaimer) {
        md += formatReportSection('免责声明', content.disclaimer, 3)
      }
    } else if (report.phase === ClinicalPhase.DISCHARGE) {
      if (content.finalDiagnosis) {
        md += formatReportSection('最终诊断', content.finalDiagnosis, 3)
      }

      if (content.adjuvantPlan) {
        md += formatReportSection('辅助方案', content.adjuvantPlan, 3)
      }

      if (content.prognosisEvaluation) {
        md += formatReportSection('预后评估', content.prognosisEvaluation, 3)
      }

      if (content.disclaimer) {
        md += formatReportSection('免责声明', content.disclaimer, 3)
      }
    } else {
      // Fallback to legacy generic structure
      if (content.caseSummary) {
        md += formatReportSection('病例摘要 (Case Summary)', content.caseSummary, 3)
      }

      if (content.reasoningProcess?.keyQuestions || content.reasoningProcess?.differentialDiagnosis) {
        md += formatReasoning(content)
      }

      if (content.conclusion) {
        md += formatReportSection('结论 (Conclusion)', content.conclusion, 3)
      }

      if (Array.isArray(content.recommendations)) {
        md += formatReportSection('建议 (Recommendations)', '', 3)
        content.recommendations.forEach((rec: string, idx: number) => {
          md += `${idx + 1}. ${rec}\n`
        })
        md += '\n'
      }

      if (content.disclaimer) {
        md += formatReportSection('免责声明 (Disclaimer)', content.disclaimer, 3)
      }
    }
  }

  if (report.tokenUsage) {
    md += formatReportSection('Token 使用统计', '', 3)
    md += `- 输入: ${report.tokenUsage.inputTokens.toLocaleString()}\n`
    md += `- 输出: ${report.tokenUsage.outputTokens.toLocaleString()}\n`
    md += `- 总计: ${report.tokenUsage.totalTokens.toLocaleString()}\n\n`
  }

  return md
}

export function generateSelfOptimizedReportMd(report: OptimizedReport, index: number): string {
  if (!report.content) return ''

  const content = report.content as any

  let md = formatReportSection(`${index + 1}. ${report.modelName} 自我优化报告`, '', 2)

  if (report.baselineScore !== undefined && report.optimizedScore !== undefined) {
    md += `**改进幅度**: ${report.optimizedScore - report.baselineScore >= 0 ? '+' : ''}${(report.optimizedScore - report.baselineScore).toFixed(1)}\n\n`
  }

  if (content.treatmentTimeline || content.pathologyAssessment || content.adjuvantTherapyPlan) {
    md += formatIntegrativeDischargeReport(content)
  } else {
    if (report.phase === ClinicalPhase.OUTPATIENT) {
      if (content.diagnosticConclusion) {
        md += formatReportSection('诊断结论', content.diagnosticConclusion, 3)
      }

      if (content.decisionLogic) {
        md += formatReportSection('决策逻辑', content.decisionLogic, 3)
      }

      if (content.treatmentPlan) {
        md += formatReportSection('拟定医嘱', content.treatmentPlan, 3)
      }

      if (content.disclaimer) {
        md += formatReportSection('免责声明', content.disclaimer, 3)
      }
    } else if (report.phase === ClinicalPhase.INPATIENT) {
      if (content.responseEvaluation) {
        md += formatReportSection('疗效评级', content.responseEvaluation, 3)
      }

      if (content.surgicalPlan) {
        md += formatReportSection('手术预案', content.surgicalPlan, 3)
      }

      if (content.keyConcerns) {
        md += formatReportSection('关键关注点', content.keyConcerns, 3)
      }

      if (content.disclaimer) {
        md += formatReportSection('免责声明', content.disclaimer, 3)
      }
    } else if (report.phase === ClinicalPhase.DISCHARGE) {
      if (content.finalDiagnosis) {
        md += formatReportSection('最终诊断', content.finalDiagnosis, 3)
      }

      if (content.adjuvantPlan) {
        md += formatReportSection('辅助方案', content.adjuvantPlan, 3)
      }

      if (content.prognosisEvaluation) {
        md += formatReportSection('预后评估', content.prognosisEvaluation, 3)
      }

      if (content.disclaimer) {
        md += formatReportSection('免责声明', content.disclaimer, 3)
      }
    } else {
      // Fallback to legacy generic structure
      if (content.caseSummary) {
        md += formatReportSection('病例摘要 (Case Summary)', content.caseSummary, 3)
      }

      if (content.reasoningProcess?.keyQuestions || content.reasoningProcess?.differentialDiagnosis) {
        md += formatReasoning(content)
      }

      if (content.conclusion) {
        md += formatReportSection('结论 (Conclusion)', content.conclusion, 3)
      }

      if (Array.isArray(content.recommendations)) {
        md += formatReportSection('建议 (Recommendations)', '', 3)
        content.recommendations.forEach((rec: string, idx: number) => {
          md += `${idx + 1}. ${rec}\n`
        })
        md += '\n'
      }

      if (content.disclaimer) {
        md += formatReportSection('免责声明 (Disclaimer)', content.disclaimer, 3)
      }
    }
  }

  if (Array.isArray(report.citations) && report.citations.length > 0) {
    md += formatReportSection('临床指南引用 (Clinical Guideline Citations)', '', 3)
    report.citations.forEach((c, idx) => {
      md += `${idx + 1}. **${c.guidelineName || '未命名指南'}**\n`
      if (c.source) md += `   - 来源: ${c.source}\n`
      if (c.quote) md += `   - 引用: ${c.quote}\n`
    })
    md += '\n'
  }

  return md
}

export function generatePeerReviewDetailsMd(peerReviews: import('../types/scoring').PeerReview[]): string {
  if (!peerReviews || peerReviews.length === 0) return ''

  let md = '## 同行评审详细意见\n\n'

  const grouped: Record<string, import('../types/scoring').PeerReview[]> = {}

  peerReviews.forEach(review => {
    const key = `${review.targetModelId}::${review.targetModelName}`
    if (!grouped[key]) {
      grouped[key] = []
    }
    grouped[key].push(review)
  })

  const entries = Object.entries(grouped)

  entries.forEach(([key, reviews], index) => {
    const parts = key.split('::')
    const modelName = parts[1] || parts[0]

    md += `### ${index + 1}. 针对 ${modelName} 的评审\n\n`
    md += '| 评审者 | 准确性 | 完整性 | 安全性 | 清晰度 | 加权总分 | fatalFlag |\n'
    md += '|--------|--------|--------|--------|--------|----------|----------|\n'

    reviews.forEach(r => {
      const fatal = r.fatalFlag ? '是' : '否'
      md += `| ${r.evaluatorModelName} | ${r.scores.accuracy} | ${r.scores.completeness} | ${r.scores.safety} | ${r.scores.clarity} | ${r.weightedOverallScore.toFixed(2)} | ${fatal} |\n`
    })

    md += '\n'
    md += '**评审理由摘要：**\n\n'

    reviews.forEach(r => {
      md += `- ${r.evaluatorModelName}\n`
      if (r.justification.accuracy) {
        md += `  - 准确性: ${r.justification.accuracy}\n`
      }
      if (r.justification.completeness) {
        md += `  - 完整性: ${r.justification.completeness}\n`
      }
      if (r.justification.safety) {
        md += `  - 安全性: ${r.justification.safety}\n`
      }
      if (r.justification.clarity) {
        md += `  - 清晰度: ${r.justification.clarity}\n`
      }
    })

    md += '\n'
  })

  return md
}

export function generateScoringMatrixMd(finalData: FinalReportData): string {
  let md = formatReportSection('4. Scoring Matrix', '', 2)

  md += '| Report \\\\ Evaluator | '
  MODELS.forEach(m => { md += `${m.name} | ` })
  md += 'Average |\n'

  md += '|' + '---|'.repeat(MODELS.length + 2) + '\n'

  MODELS.forEach((reportModel) => {
    md += `| ${reportModel.name} | `

    MODELS.forEach((evalModel) => {
      const review = finalData.peerReviews.find(
        r => r.evaluatorModelId === evalModel.id &&
          r.targetModelId === reportModel.id
      )
      md += review ? `${review.weightedOverallScore.toFixed(1)} | ` : '- | '
    })

    const avg = finalData.averageScores[reportModel.id] || 0
    md += `${avg.toFixed(1)} |\n`
  })

  md += '\n'

  return md
}

export function generateFullReportMd(finalData: FinalReportData): string {
  const today = new Date().toLocaleDateString('zh-CN')

  let md = `# AI Medical Consultation Research Report\n\n`
  md += `**Generated**: ${today}\n\n`
  md += `**Winner**: ${finalData.winningReport.modelName} (Score: ${finalData.averageScores[finalData.winningReport.modelId].toFixed(1)})\n\n`

  md += '---\n\n'

  md += formatReportSection('1. Baseline Reports', '', 1)
  finalData.allReports.forEach((report, idx) => {
    md += generateBaselineReportMd(report, idx)
  })

  md += formatReportSection('2. Self-Optimized Reports', '', 1)
  finalData.selfOptimizedReports.forEach((report, idx) => {
    md += generateSelfOptimizedReportMd(report as OptimizedReport, idx)
  })

  md += formatReportSection('3. Peer Reviews', '', 1)
  md += generateScoringMatrixMd(finalData)

  md += '---\n\n'
  md += `**Disclaimer**: This report was generated by AI models and is for research purposes only. It should not replace professional medical judgment.`

  return md
}

export function exportToFile(content: string, filename: string, type: 'md' | 'txt' = 'md'): void {
  const blob = new Blob([content], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${filename}.${type}`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
