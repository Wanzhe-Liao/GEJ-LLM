// Retry Helper with Exponential Backoff
// Handles network errors and transient failures

export interface RetryConfig {
  maxRetries: number
  initialDelayMs: number
  maxDelayMs: number
  backoffMultiplier: number
  retryableErrors: string[]
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 20,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  retryableErrors: [
    'Failed to fetch',
    'NetworkError',
    'ERR_CONNECTION_CLOSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'Rate limit',
    '429',
    '500',
    '502',
    '503',
    '504',
    '520',
    '521',
    '522',
    '523',
    '524',
    'timeout',
    'socket hang up',
    'ECONNABORTED',
    'Connection reset'
  ]
}

function isRetryableError(error: any, config: RetryConfig): boolean {
  const errorMessage = error?.message || error?.toString() || ''
  return config.retryableErrors.some(pattern => errorMessage.includes(pattern))
}

function calculateDelay(attempt: number, config: RetryConfig): number {
  const delay = Math.min(
    config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt),
    config.maxDelayMs
  )
  const jitter = Math.random() * 0.3 * delay
  return Math.floor(delay + jitter)
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  context: string,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<T> {
  let lastError: any

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = calculateDelay(attempt - 1, config)
        console.log(`🔄 [${context}] 重试 ${attempt}/${config.maxRetries}，等待 ${delay}ms...`)
        await sleep(delay)
      }

      const result = await fn()

      if (attempt > 0) {
        console.log(`✅ [${context}] 重试成功！`)
      }

      return result

    } catch (error) {
      lastError = error
      const isRetryable = isRetryableError(error, config)
      const isLastAttempt = attempt === config.maxRetries

      if (!isRetryable) {
        console.error(`❌ [${context}] 不可重试的错误:`, error)
        throw error
      }

      if (isLastAttempt) {
        console.error(`❌ [${context}] 达到最大重试次数 (${config.maxRetries})`)
        console.error(`❌ [${context}] 所有重试失败，最终错误:`, lastError)
        throw new Error(`${context} failed after ${config.maxRetries} retries: ${lastError.message}`)
      }

      const matchedPattern = config.retryableErrors.find(pattern =>
        (lastError.message || '').includes(pattern)
      )
      console.warn(`⚠️ [${context}] 尝试 ${attempt + 1} 失败 (匹配: ${matchedPattern || '未知'}): ${lastError.message}`)
    }
  }

  throw lastError
}

export function getModelSpecificRetryConfig(modelId: string): RetryConfig {
  const baseConfig = { ...DEFAULT_RETRY_CONFIG }

  if (modelId === 'grok-4') {
    return {
      ...baseConfig,
      maxRetries: 20,
      initialDelayMs: 2000,
      maxDelayMs: 30000
    }
  }

  if (modelId === 'gpt-5') {
    return {
      ...baseConfig,
      maxRetries: 20,
      initialDelayMs: 2000,
      maxDelayMs: 30000
    }
  }

  if (modelId === 'gpt-5-nano') {
    return {
      ...baseConfig,
      maxRetries: 20,
      initialDelayMs: 2000,
      maxDelayMs: 30000
    }
  }

  if (modelId.includes('claude')) {
    return {
      ...baseConfig,
      maxRetries: 20,
      initialDelayMs: 3000,
      maxDelayMs: 30000
    }
  }

  if (modelId.includes('gemini')) {
    return {
      ...baseConfig,
      maxRetries: 20,
      initialDelayMs: 1500
    }
  }

  if (modelId.includes('gpt')) {
    return {
      ...baseConfig,
      maxRetries: 20,
      initialDelayMs: 3000,
      maxDelayMs: 30000
    }
  }

  return baseConfig
}
