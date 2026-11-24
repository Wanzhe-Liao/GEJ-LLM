interface Citation {
  guidelineName: string
  source?: string
  quote?: string
  appliedTo?: string
  evidenceLevel?: string
  mcpSourceIndex?: number
}

interface ChangeLogEntry {
  field: string
  statementId?: string
  changeType: string
  original: string
  optimized: string
  classification: string
  guidelineEvidence: string
  citationId?: string
  evidenceTier?: string
  resolutionRule?: string
  clinicalRationale: string
}

interface ValidationResult {
  isValid: boolean
  validCitations: Citation[]
  invalidCitations: Citation[]
  invalidChangeLogEntries: ChangeLogEntry[]
  metrics: {
    totalCitations: number
    validCitationsCount: number
    invalidCitationsCount: number
    citationValidityRate: number
    changeLogCoverageRate: number
  }
  warnings: string[]
  errors: string[]
}

export function validateCitations(
  modelCitations: Citation[],
  mcpCitations: Citation[],
  changeLog: ChangeLogEntry[]
): ValidationResult {
  const warnings: string[] = []
  const errors: string[] = []

  const mcpGuidelineNames = new Set(
    mcpCitations.map(c => c.guidelineName)
  )

  const validCitations = modelCitations.filter(c =>
    mcpGuidelineNames.has(c.guidelineName)
  )

  const invalidCitations = modelCitations.filter(c =>
    !mcpGuidelineNames.has(c.guidelineName)
  )

  if (invalidCitations.length > 0) {
    errors.push(
      `检测到${invalidCitations.length}个无效引用（未在MCP返回中）: ${invalidCitations.map(c => c.guidelineName).join(', ')}`
    )
    errors.push(
      `合法的指南来源仅包括: ${Array.from(mcpGuidelineNames).join(', ') || '(空)'}`
    )
  }

  const invalidChangeLogEntries = changeLog
    .filter(entry => entry.citationId)
    .filter(entry => {
      const citationId = entry.citationId!
      return !mcpCitations.some(mc => mc.guidelineName === citationId)
    })

  if (invalidChangeLogEntries.length > 0) {
    warnings.push(
      `changeLog中有${invalidChangeLogEntries.length}个无效的citationId引用`
    )
  }

  const changeLogWithValidCitations = changeLog.filter(entry =>
    entry.citationId && mcpCitations.some(mc => mc.guidelineName === entry.citationId)
  )

  const changeLogCoverageRate = changeLog.length > 0
    ? changeLogWithValidCitations.length / changeLog.length
    : 0

  if (changeLogCoverageRate < 0.5 && changeLog.length > 0) {
    warnings.push(
      `changeLog中只有${(changeLogCoverageRate * 100).toFixed(1)}%的条目有有效的citationId关联`
    )
  }

  const citationValidityRate = modelCitations.length > 0
    ? validCitations.length / modelCitations.length
    : 1.0

  const isValid = invalidCitations.length === 0 &&
                  invalidChangeLogEntries.length === 0 &&
                  citationValidityRate >= 0.8

  return {
    isValid,
    validCitations,
    invalidCitations,
    invalidChangeLogEntries,
    metrics: {
      totalCitations: modelCitations.length,
      validCitationsCount: validCitations.length,
      invalidCitationsCount: invalidCitations.length,
      citationValidityRate,
      changeLogCoverageRate
    },
    warnings,
    errors
  }
}

export function filterInvalidCitations(
  modelCitations: Citation[],
  mcpCitations: Citation[]
): Citation[] {
  const mcpGuidelineNames = new Set(
    mcpCitations.map(c => c.guidelineName)
  )

  return modelCitations.filter(c =>
    mcpGuidelineNames.has(c.guidelineName)
  )
}

export function getModelSpecificValidationConfig(modelName: string) {
  const configs: Record<string, {
    enableStrictValidation: boolean
    additionalWarnings: string[]
    minCitationValidityRate: number
  }> = {
    'kimi-k2': {
      enableStrictValidation: true,
      additionalWarnings: [
        '特别注意：不要使用ESPEN、ONS、ACS、ASH等训练数据中的医学组织',
        '如果你不确定某个指南是否在[引用信息]中，不要使用它',
        '当[引用信息]为空时，优先标注"缺乏指南支持"而非凭记忆添加引用'
      ],
      minCitationValidityRate: 0.95
    },
    'gpt-4': {
      enableStrictValidation: false,
      additionalWarnings: [],
      minCitationValidityRate: 0.8
    },
    'claude': {
      enableStrictValidation: false,
      additionalWarnings: [],
      minCitationValidityRate: 0.8
    },
    'qwen': {
      enableStrictValidation: true,
      additionalWarnings: [
        '只能使用[引用信息]中明确列出的指南'
      ],
      minCitationValidityRate: 0.9
    },
    'glm': {
      enableStrictValidation: true,
      additionalWarnings: [
        '只能使用[引用信息]中明确列出的指南'
      ],
      minCitationValidityRate: 0.9
    }
  }

  const normalizedName = modelName.toLowerCase()

  for (const [key, config] of Object.entries(configs)) {
    if (normalizedName.includes(key)) {
      return config
    }
  }

  return {
    enableStrictValidation: true,
    additionalWarnings: [],
    minCitationValidityRate: 0.85
  }
}

export function generateValidationReport(
  modelName: string,
  validationResult: ValidationResult
): string {
  const { metrics, warnings, errors } = validationResult

  let report = `\n=== Citation Validation Report for ${modelName} ===\n`
  report += `Total Citations: ${metrics.totalCitations}\n`
  report += `Valid: ${metrics.validCitationsCount} | Invalid: ${metrics.invalidCitationsCount}\n`
  report += `Citation Validity Rate: ${(metrics.citationValidityRate * 100).toFixed(1)}%\n`
  report += `ChangeLog Coverage Rate: ${(metrics.changeLogCoverageRate * 100).toFixed(1)}%\n`

  if (errors.length > 0) {
    report += `\n❌ Errors:\n`
    errors.forEach(err => {
      report += `  - ${err}\n`
    })
  }

  if (warnings.length > 0) {
    report += `\n⚠️  Warnings:\n`
    warnings.forEach(warn => {
      report += `  - ${warn}\n`
    })
  }

  if (validationResult.isValid) {
    report += `\n✅ Validation PASSED\n`
  } else {
    report += `\n❌ Validation FAILED\n`
  }

  report += `====================================================\n`

  return report
}

export function applyAutomaticFix(
  modelCitations: Citation[],
  mcpCitations: Citation[],
  modelName: string
): {
  fixedCitations: Citation[]
  removedCount: number
  fixLog: string[]
} {
  const mcpGuidelineNames = new Set(
    mcpCitations.map(c => c.guidelineName)
  )

  const fixedCitations = modelCitations.filter(c =>
    mcpGuidelineNames.has(c.guidelineName)
  )

  const removedCitations = modelCitations.filter(c =>
    !mcpGuidelineNames.has(c.guidelineName)
  )

  const fixLog: string[] = []

  if (removedCitations.length > 0) {
    fixLog.push(
      `🔧 [${modelName}] 自动移除${removedCitations.length}个无效引用:`
    )
    removedCitations.forEach(c => {
      fixLog.push(`   - ${c.guidelineName} (应用于: ${c.appliedTo || 'unknown'})`)
    })
    fixLog.push(`   保留${fixedCitations.length}个有效引用`)
  } else {
    fixLog.push(`✅ [${modelName}] 所有引用均有效，无需修复`)
  }

  return {
    fixedCitations,
    removedCount: removedCitations.length,
    fixLog
  }
}

export function checkCitationConsistency(
  citations: Citation[],
  changeLog: ChangeLogEntry[]
): {
  orphanedCitations: Citation[]
  orphanedChangeLogEntries: ChangeLogEntry[]
  consistency: number
} {
  const citationGuidelineNames = new Set(
    citations.map(c => c.guidelineName)
  )

  const changeLogCitationIds = new Set(
    changeLog.filter(e => e.citationId).map(e => e.citationId!)
  )

  const orphanedCitations = citations.filter(c =>
    !changeLogCitationIds.has(c.guidelineName)
  )

  const orphanedChangeLogEntries = changeLog
    .filter(e => e.citationId)
    .filter(e => !citationGuidelineNames.has(e.citationId!))

  const totalItems = citations.length + changeLog.filter(e => e.citationId).length
  const consistentItems = totalItems - orphanedCitations.length - orphanedChangeLogEntries.length

  const consistency = totalItems > 0 ? consistentItems / totalItems : 1.0

  return {
    orphanedCitations,
    orphanedChangeLogEntries,
    consistency
  }
}
