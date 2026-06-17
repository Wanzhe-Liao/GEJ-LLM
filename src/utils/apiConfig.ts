// API Configuration Validation and Debugging Utility

import { MODELS, getModel, validateModelConfig } from './models'

export interface ApiConfigStatus {
  modelId: string
  modelName: string
  hasApiKey: boolean
  hasBaseUrl: boolean
  provider: string
  apiKeyEnvVar: string
  baseUrlEnvVar?: string
  status: 'configured' | 'missing_key' | 'missing_url' | 'error'
}

export function validateAllApiConfigs(): ApiConfigStatus[] {
  return MODELS.map(model => {
    const hasApiKey = validateModelConfig(model.id)
    const baseUrlKey = model.baseURLEnvKey
    const hasBaseUrl = !baseUrlKey || !!(import.meta.env as any)[baseUrlKey]

    let status: 'configured' | 'missing_key' | 'missing_url' | 'error'
    if (!hasApiKey) status = 'missing_key'
    else if (!hasBaseUrl) status = 'missing_url'
    else status = 'configured'

    return {
      modelId: model.id,
      modelName: model.name,
      hasApiKey,
      hasBaseUrl,
      provider: model.provider || 'unknown',
      apiKeyEnvVar: model.apiKeyEnvKey || 'VITE_API_KEY',
      baseUrlEnvVar: baseUrlKey,
      status
    }
  })
}

export function getApiDiagnostics(): string {
  const configs = validateAllApiConfigs()
  const configured = configs.filter(c => c.status === 'configured')
  const missingKeys = configs.filter(c => c.status === 'missing_key')
  const missingUrls = configs.filter(c => c.status === 'missing_url')

  let diagnostics = '=== API Configuration Diagnostics ===\n'
  diagnostics += `Total Models: ${configs.length}\n`
  diagnostics += `Configured: ${configured.length}\n`
  diagnostics += `Missing API Keys: ${missingKeys.length}\n`
  diagnostics += `Missing URLs: ${missingUrls.length}\n\n`

  if (missingKeys.length > 0) {
    diagnostics += 'Missing API Keys:\n'
    missingKeys.forEach(c => {
      diagnostics += `  - ${c.modelName} (${c.modelId}): Set ${c.apiKeyEnvVar}\n`
    })
    diagnostics += '\n'
  }

  if (missingUrls.length > 0) {
    diagnostics += 'Missing Base URLs:\n'
    missingUrls.forEach(c => {
      diagnostics += `  - ${c.modelName} (${c.modelId}): Set ${c.baseUrlEnvVar}\n`
    })
    diagnostics += '\n'
  }

  diagnostics += 'Environment Variables Required:\n'
  const envVars = new Set(configs.flatMap(c => [c.apiKeyEnvVar, c.baseUrlEnvVar].filter(Boolean)))
  envVars.forEach(envVar => {
    const value = (import.meta.env as any)[envVar]
    diagnostics += `  - ${envVar}: ${value ? '✓ Set' : '✗ Missing'}\n`
  })

  return diagnostics
}

export function logApiDiagnostics(): void {
  console.log(getApiDiagnostics())
}