// AI Model definitions

export interface Model {
  id: string;
  name: string;
  baseURLEnvKey?: string;
  apiKeyEnvKey?: string;
  provider?: 'openai' | 'anthropic' | 'google' | 'moonshot' | 'apiplus' | 'deepseek';
}

export const MODELS: Model[] = [
  {
    id: 'gpt-5',
    name: 'GPT-5',
    baseURLEnvKey: 'VITE_API_URL_GPT5_APTGE',
    apiKeyEnvKey: 'VITE_API_KEY_GPT5_APTGE',
    provider: 'apiplus'
  },
  {
    id: 'grok-4',
    name: 'Grok 4',
    baseURLEnvKey: 'VITE_API_URL_GROK_APTGE',
    apiKeyEnvKey: 'VITE_API_KEY_GROK_APTGE',
    provider: 'apiplus'
  },
  {
    id: 'gemini-3-pro-preview-11-2025',
    name: 'Gemini 3 Pro Preview',
    baseURLEnvKey: 'VITE_API_URL_APIPLUS',
    apiKeyEnvKey: 'VITE_API_KEY_GEMINI',
    provider: 'apiplus'
  },
  {
    id: 'kimi-k2-thinking',
    name: 'Kimi K2 Thinking',
    baseURLEnvKey: 'VITE_API_URL_MOONSHOT',
    apiKeyEnvKey: 'VITE_API_KEY_MOONSHOT',
    provider: 'moonshot'
  },
  {
    id: 'qwen3-max',
    name: 'Qwen3 Max',
    baseURLEnvKey: 'VITE_API_URL_GPTGE',
    apiKeyEnvKey: 'VITE_API_KEY_GPTGE',
    provider: 'apiplus'
  }
];

// JSON repair model (not for main research, only for error recovery)
// 使用 DeepSeek Reasoner
export const JSON_REPAIR_MODEL: Model = {
  id: 'deepseek-reasoner',
  name: 'DeepSeek Reasoner (JSON Repair)',
  baseURLEnvKey: 'VITE_API_URL_DEEPSEEK',
  apiKeyEnvKey: 'VITE_API_KEY_DEEPSEEK',
  provider: 'deepseek'
};

// Type-only model for guideline queries (cheaper)
export const TYPE_MODEL: Model = {
  id: 'gpt-3.5-turbo',
  name: 'GPT-3.5 Turbo',
  provider: 'openai'
};

// Helper function to get model by ID
export function getModel(modelId: string): Model {
  return MODELS.find(m => m.id === modelId) || TYPE_MODEL;
}

// Helper function to validate model configuration
export function validateModelConfig(modelId: string): boolean {
  const model = getModel(modelId);
  if (!model) return false;

  const apiKeyKey = model.apiKeyEnvKey;
  if (!apiKeyKey) return false;

  return !!(import.meta.env as any)[apiKeyKey] || !!import.meta.env.VITE_API_KEY;
}
