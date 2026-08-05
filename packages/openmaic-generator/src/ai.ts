import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, type JSONValue, type LanguageModel } from 'ai';
import {
  getProviderCatalogEntry,
  getModelOutputWindow,
  modelSupportsVision,
  type ProviderType,
} from './contracts/providers.js';
import { OpenMaicError, throwIfAborted } from './errors.js';
import { createNetworkAdapter } from './network.js';

export interface LLMImage {
  id: string;
  data: Buffer | string;
  mimeType?: string;
  width?: number;
  height?: number;
}

export interface LLMGenerateInput {
  system: string;
  user: string;
  images?: LLMImage[];
  signal?: AbortSignal;
  maxOutputTokens?: number;
}

export interface LLMUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  providerId: string;
  modelId: string;
}

export interface LLMCaller {
  readonly supportsVision?: boolean;
  readonly outputWindow?: number;
  generate(input: LLMGenerateInput): Promise<string>;
}

export interface ThinkingConfig {
  mode?: 'default' | 'disabled' | 'enabled' | 'auto';
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  level?: 'minimal' | 'low' | 'medium' | 'high';
  budgetTokens?: number;
  excludeReasoningOutput?: boolean;
}

export interface ModelSelection {
  providerId: string;
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  providerType?: ProviderType;
  vision?: boolean;
  outputWindow?: number;
  thinking?: ThinkingConfig;
}

export interface CreateLLMCallerOptions {
  model: ModelSelection;
  onUsage?: (usage: LLMUsage) => void | Promise<void>;
  onDebug?: (message: string) => void;
}

export function parseModelString(model: string): { providerId: string; modelId: string } {
  const separator = model.indexOf(':');
  if (separator < 0) return { providerId: 'openai', modelId: model };
  const providerId = model.slice(0, separator).trim();
  const modelId = model.slice(separator + 1).trim();
  if (!providerId || !modelId) {
    throw new OpenMaicError(
      'CONFIG_ERROR',
      `Invalid model string "${model}"; expected provider:model`,
    );
  }
  return { providerId, modelId };
}

export function resolveModelSelection(
  modelString = process.env.DEFAULT_MODEL,
  overrides: Partial<ModelSelection> = {},
): ModelSelection {
  if (!modelString && (!overrides.providerId || !overrides.modelId)) {
    throw new OpenMaicError('CONFIG_ERROR', 'No model configured. Set --model or DEFAULT_MODEL.');
  }
  const parsed = modelString ? parseModelString(modelString) : undefined;
  const providerId = overrides.providerId ?? parsed?.providerId ?? '';
  const modelId = overrides.modelId ?? parsed?.modelId ?? '';
  const catalog = getProviderCatalogEntry(providerId);
  const envPrefix = catalog?.envPrefix ?? providerId.toUpperCase().replace(/-/g, '_');
  const aliases =
    providerId === 'tencent-hunyuan'
      ? ['TENCENT_HUNYUAN', 'TENCENT']
      : providerId === 'xiaomi'
        ? ['XIAOMI', 'MIMO']
        : [envPrefix];
  const apiKey =
    overrides.apiKey ?? aliases.map((prefix) => process.env[`${prefix}_API_KEY`]).find(Boolean);
  const baseUrl =
    overrides.baseUrl ??
    aliases.map((prefix) => process.env[`${prefix}_BASE_URL`]).find(Boolean) ??
    catalog?.defaultBaseUrl;
  const providerType = overrides.providerType ?? catalog?.type;
  if (!providerType) {
    throw new OpenMaicError(
      'CONFIG_ERROR',
      `Unknown provider "${providerId}". Custom providers must set providerType.`,
    );
  }
  if ((catalog?.requiresApiKey ?? true) && !apiKey) {
    throw new OpenMaicError(
      'PROVIDER_ERROR',
      `Missing ${envPrefix}_API_KEY for ${providerId}:${modelId}`,
    );
  }
  return {
    providerId,
    modelId,
    apiKey,
    baseUrl,
    providerType,
    thinking: overrides.thinking,
    vision: overrides.vision ?? modelSupportsVision(providerId, modelId),
    outputWindow: overrides.outputWindow ?? getModelOutputWindow(providerId, modelId),
  };
}

function normalizeAzureBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  return baseUrl.replace(/\/+$/, '').replace(/\/openai$/, '');
}

function thinkingProviderOptions(
  providerType: ProviderType,
  thinking?: ThinkingConfig,
): Record<string, Record<string, JSONValue | undefined>> | undefined {
  if (!thinking || thinking.mode === 'default') return undefined;
  if (providerType === 'openai' && thinking.effort) {
    return { openai: { reasoningEffort: thinking.effort } };
  }
  if (providerType === 'anthropic') {
    if (thinking.mode === 'disabled') return { anthropic: { thinking: { type: 'disabled' } } };
    if (thinking.budgetTokens) {
      return { anthropic: { thinking: { type: 'enabled', budgetTokens: thinking.budgetTokens } } };
    }
  }
  if (providerType === 'google') {
    if (thinking.level) return { google: { thinkingConfig: { thinkingLevel: thinking.level } } };
    if (thinking.budgetTokens !== undefined) {
      return { google: { thinkingConfig: { thinkingBudget: thinking.budgetTokens } } };
    }
  }
  return undefined;
}

function compatibleThinkingBody(thinking?: ThinkingConfig): Record<string, unknown> | undefined {
  if (!thinking || thinking.mode === 'default') return undefined;
  const body: Record<string, unknown> = {};
  if (thinking.mode === 'disabled') body.enable_thinking = false;
  if (thinking.mode === 'enabled') body.enable_thinking = true;
  if (thinking.budgetTokens !== undefined) body.thinking_budget = thinking.budgetTokens;
  if (thinking.effort) body.reasoning_effort = thinking.effort;
  return Object.keys(body).length ? body : undefined;
}

function createModel(selection: ModelSelection, debug?: (message: string) => void): LanguageModel {
  const fetchImpl = createNetworkAdapter({ onDebug: debug });
  const type = selection.providerType;
  if (!type) throw new OpenMaicError('CONFIG_ERROR', 'Provider type is missing');

  if (type === 'azure') {
    return createAzure({
      apiKey: selection.apiKey,
      baseURL: normalizeAzureBaseUrl(selection.baseUrl),
      fetch: fetchImpl as typeof fetch,
    })(selection.modelId);
  }
  if (type === 'anthropic') {
    const anthropic = createAnthropic({
      apiKey: selection.apiKey,
      baseURL: selection.baseUrl,
      fetch: fetchImpl as typeof fetch,
    });
    return anthropic.chat(selection.modelId);
  }
  if (type === 'google') {
    return createGoogleGenerativeAI({
      apiKey: selection.apiKey,
      baseURL: selection.baseUrl,
      fetch: fetchImpl as typeof fetch,
    }).chat(selection.modelId);
  }

  const compatFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const extra =
      selection.providerId === 'openai' ? undefined : compatibleThinkingBody(selection.thinking);
    if (extra && typeof init?.body === 'string') {
      try {
        init = { ...init, body: JSON.stringify({ ...JSON.parse(init.body), ...extra }) };
      } catch {
        // Preserve an opaque request body.
      }
    }
    return fetchImpl(input, init);
  };
  const openai = createOpenAI({
    apiKey: selection.apiKey ?? '',
    baseURL: selection.baseUrl,
    fetch: compatFetch as typeof fetch,
  });
  const useResponses =
    selection.providerId === 'openai' &&
    (/^gpt-5\.\d+-pro(?:-|$)/.test(selection.modelId) ||
      /^gpt-5\.[5-9](?:-|$)/.test(selection.modelId));
  return useResponses ? openai.responses(selection.modelId) : openai.chat(selection.modelId);
}

export function createLLMCaller(options: CreateLLMCallerOptions): LLMCaller {
  const model = createModel(options.model, options.onDebug);
  return {
    supportsVision:
      options.model.vision ?? modelSupportsVision(options.model.providerId, options.model.modelId),
    outputWindow: options.model.outputWindow,
    async generate(input) {
      throwIfAborted(input.signal);
      const userContent = input.images?.length
        ? [
            { type: 'text' as const, text: input.user },
            ...input.images.flatMap((image) => [
              { type: 'text' as const, text: `\n**${image.id}**:` },
              {
                type: 'image' as const,
                image: Buffer.isBuffer(image.data) ? image.data : image.data,
                ...(image.mimeType ? { mediaType: image.mimeType } : {}),
              },
            ]),
          ]
        : undefined;
      const result = await generateText({
        model,
        system: input.system,
        ...(userContent
          ? { messages: [{ role: 'user' as const, content: userContent }] }
          : { prompt: input.user }),
        abortSignal: input.signal,
        maxOutputTokens: input.maxOutputTokens,
        providerOptions: thinkingProviderOptions(
          options.model.providerType ?? 'openai',
          options.model.thinking,
        ),
      });
      await options.onUsage?.({
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
        providerId: options.model.providerId,
        modelId: options.model.modelId,
      });
      return result.text;
    },
  };
}
