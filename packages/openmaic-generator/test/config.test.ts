import { describe, expect, it } from 'vitest';
import {
  getCanonicalModelId,
  modelSupportsVision,
  parseModelString,
  redactSensitive,
  resolveModelSelection,
} from '../src/index.js';

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
});
