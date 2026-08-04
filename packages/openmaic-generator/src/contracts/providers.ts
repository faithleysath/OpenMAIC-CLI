import type { CliAgent } from './types.js';

export type ProviderType = 'openai' | 'azure' | 'anthropic' | 'google';

export interface ProviderCatalogEntry {
  id: string;
  name: string;
  type: ProviderType;
  envPrefix: string;
  defaultBaseUrl?: string;
  requiresApiKey: boolean;
}

export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    type: 'openai',
    envPrefix: 'OPENAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
  },
  {
    id: 'azure',
    name: 'Azure OpenAI',
    type: 'azure',
    envPrefix: 'AZURE_OPENAI',
    requiresApiKey: true,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    type: 'anthropic',
    envPrefix: 'ANTHROPIC',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    requiresApiKey: true,
  },
  {
    id: 'google',
    name: 'Google Gemini',
    type: 'google',
    envPrefix: 'GOOGLE',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    requiresApiKey: true,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'openai',
    envPrefix: 'DEEPSEEK',
    defaultBaseUrl: 'https://api.deepseek.com',
    requiresApiKey: true,
  },
  {
    id: 'qwen',
    name: 'Qwen',
    type: 'openai',
    envPrefix: 'QWEN',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    requiresApiKey: true,
  },
  {
    id: 'kimi',
    name: 'Kimi',
    type: 'openai',
    envPrefix: 'KIMI',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    requiresApiKey: true,
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    type: 'anthropic',
    envPrefix: 'MINIMAX',
    defaultBaseUrl: 'https://api.minimaxi.com/anthropic/v1',
    requiresApiKey: true,
  },
  {
    id: 'glm',
    name: 'GLM',
    type: 'openai',
    envPrefix: 'GLM',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    requiresApiKey: true,
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    type: 'openai',
    envPrefix: 'SILICONFLOW',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    requiresApiKey: true,
  },
  {
    id: 'doubao',
    name: 'Doubao',
    type: 'openai',
    envPrefix: 'DOUBAO',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    requiresApiKey: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    type: 'openai',
    envPrefix: 'OPENROUTER',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
  },
  {
    id: 'grok',
    name: 'Grok',
    type: 'openai',
    envPrefix: 'GROK',
    defaultBaseUrl: 'https://api.x.ai/v1',
    requiresApiKey: true,
  },
  {
    id: 'tencent-hunyuan',
    name: 'Tencent Hunyuan',
    type: 'openai',
    envPrefix: 'TENCENT_HUNYUAN',
    defaultBaseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    requiresApiKey: true,
  },
  {
    id: 'xiaomi',
    name: 'Xiaomi MiMo',
    type: 'openai',
    envPrefix: 'XIAOMI',
    defaultBaseUrl: 'https://api.xiaomimimo.com/v1',
    requiresApiKey: true,
  },
  {
    id: 'lemonade',
    name: 'Lemonade',
    type: 'openai',
    envPrefix: 'LEMONADE',
    defaultBaseUrl: 'http://localhost:13305/v1',
    requiresApiKey: false,
  },
  {
    id: 'ollama',
    name: 'Ollama',
    type: 'openai',
    envPrefix: 'OLLAMA',
    defaultBaseUrl: 'http://localhost:11434/v1',
    requiresApiKey: false,
  },
] as const;

export const DEFAULT_AGENTS: readonly CliAgent[] = [
  {
    id: 'teacher',
    name: 'Teacher',
    role: 'teacher',
    persona: 'A clear, patient instructor who explains concepts with concrete examples.',
    avatar: '',
    color: '#2563eb',
    priority: 1,
  },
  {
    id: 'student',
    name: 'Student',
    role: 'student',
    persona: 'A curious learner who asks concise questions when a concept needs clarification.',
    avatar: '',
    color: '#16a34a',
    priority: 2,
  },
] as const;

export function getProviderCatalogEntry(id: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((provider) => provider.id === id);
}

const MODEL_ID_ALIASES: ReadonlyMap<string, string> = new Map([['openai:gpt-5.6-sol', 'gpt-5.6']]);

export function getCanonicalModelId(providerId: string, modelId: string): string {
  return MODEL_ID_ALIASES.get(`${providerId}:${modelId}`) ?? modelId;
}

export function modelIdsMatch(providerId: string, left: string, right: string): boolean {
  return getCanonicalModelId(providerId, left) === getCanonicalModelId(providerId, right);
}

export function modelSupportsVision(providerId: string, modelId: string): boolean {
  const id = `${providerId}:${getCanonicalModelId(providerId, modelId)}`.toLowerCase();
  return [
    /openai:gpt-(?:4o|4\.1|5)/,
    /azure:gpt-(?:4o|4\.1|5)/,
    /anthropic:claude-(?:3|4)/,
    /google:gemini/,
    /(?:qwen|siliconflow):.*(?:vl|vision)/,
    /kimi:.*(?:vl|vision)/,
    /glm:.*(?:4v|vision)/,
    /openrouter:.*(?:vision|vl|gpt-4o|gpt-5|claude-3|claude-4|gemini)/,
  ].some((pattern) => pattern.test(id));
}
