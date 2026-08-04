import { describe, expect, it } from 'vitest';
import { parseThinking, validateConfig } from '../src/config.js';

describe('CLI config schema', () => {
  it('rejects credentials at any nesting depth', () => {
    expect(() => validateConfig({ providers: { openai: { apiKey: 'secret' } } })).toThrow(
      /forbidden/i,
    );
  });

  it('rejects unknown configuration fields', () => {
    expect(() => validateConfig({ model: 'ollama:test', unexpected: true })).toThrow(/unknown/i);
  });

  it('rejects credentials in base URL userinfo and query parameters', () => {
    expect(() => validateConfig({ baseUrl: 'https://user:pass@example.com/v1' })).toThrow(
      /userinfo/i,
    );
    expect(() => validateConfig({ baseUrl: 'https://example.com/v1?token=secret' })).toThrow(
      /query/i,
    );
  });

  it('parses thinking modes, efforts, and budgets', () => {
    expect(parseThinking('off')).toEqual({ mode: 'disabled' });
    expect(parseThinking('high')).toEqual({ mode: 'enabled', effort: 'high' });
    expect(parseThinking('4096')).toEqual({ mode: 'enabled', budgetTokens: 4096 });
  });
});
