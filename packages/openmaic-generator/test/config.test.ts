import { describe, expect, it } from 'vitest';
import {
  diagnoseConfiguration,
  getCanonicalModelId,
  modelSupportsVision,
  parseModelString,
  redactSensitive,
  resolveModelSelection,
} from '../src/index.js';
import { IMAGE_PROVIDERS, TTS_PROVIDERS } from '../src/media/index.js';

describe('provider configuration', () => {
  it('splits only the first model separator', () => {
    expect(parseModelString('openrouter:vendor:model')).toEqual({
      providerId: 'openrouter',
      modelId: 'vendor:model',
    });
  });

  it('resolves keyless local providers', () => {
    expect(resolveModelSelection('ollama:llama3').baseUrl).toBe('http://localhost:11434/v1');
  });

  it('uses upstream model output-window metadata', () => {
    const model = resolveModelSelection('deepseek:deepseek-v4-flash', {
      apiKey: 'test-key',
    });
    expect(model.outputWindow).toBe(393_216);
  });

  it('uses upstream Seedream and Doubao TTS defaults', () => {
    expect(IMAGE_PROVIDERS.find((provider) => provider.id === 'seedream')).toMatchObject({
      defaultBaseUrl: 'https://ark.cn-beijing.volces.com',
      defaultModel: 'doubao-seedream-5-0-260128',
    });
    expect(TTS_PROVIDERS.find((provider) => provider.id === 'doubao-tts')).toMatchObject({
      defaultBaseUrl: 'https://openspeech.bytedance.com/api/v3/tts',
    });
  });

  it('keeps upstream aliases and vision capability checks', () => {
    expect(getCanonicalModelId('openai', 'gpt-5.6-sol')).toBe('gpt-5.6');
    expect(modelSupportsVision('openai', 'gpt-5.4')).toBe(true);
    expect(modelSupportsVision('ollama', 'llama3')).toBe(false);
  });

  it('redacts keys, authorization, and query tokens', () => {
    const value = redactSensitive(
      'Authorization: Bearer secret https://x.test?a=1&api_key=secret sk-123456789',
    );
    expect(value).not.toContain('secret');
    expect(value).not.toContain('sk-123456789');
  });

  it('gives provider probes enough output tokens', async () => {
    let maxOutputTokens: number | undefined;
    const checks = await diagnoseConfiguration({
      model: resolveModelSelection('ollama:test'),
      probe: true,
      llm: {
        async generate(input) {
          maxOutputTokens = input.maxOutputTokens;
          return 'OK';
        },
      },
    });
    expect(maxOutputTokens).toBe(64);
    expect(checks).toContainEqual(expect.objectContaining({ id: 'probe', ok: true }));
  });
});
