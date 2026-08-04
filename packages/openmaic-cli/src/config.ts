import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ModelSelection, ThinkingConfig } from '@faithleysath/openmaic-generator';
import {
  OpenMaicError,
  parseModelString,
  resolveModelSelection,
} from '@faithleysath/openmaic-generator';

export interface CliConfigFile {
  model?: string;
  providerType?: 'openai' | 'azure' | 'anthropic' | 'google';
  baseUrl?: string;
  baseUrls?: Record<string, string>;
  documentProvider?: string;
  searchProvider?: string;
  imageProvider?: string;
  videoProvider?: string;
  ttsProvider?: string;
  output?: string;
  thinking?: ThinkingConfig;
  concurrency?: number;
}

const FORBIDDEN_KEYS =
  /^(?:apiKey|accessKeyId|accessKeySecret|authorization|bearerToken|token|password|secret)$/i;
const TOKEN_QUERY_KEYS = /^(?:api_?key|key|token|access_token|authorization|signature|sig)$/i;
const ALLOWED_CONFIG_KEYS = new Set([
  'model',
  'providerType',
  'baseUrl',
  'baseUrls',
  'documentProvider',
  'searchProvider',
  'imageProvider',
  'videoProvider',
  'ttsProvider',
  'output',
  'thinking',
  'concurrency',
]);
const ALLOWED_THINKING_KEYS = new Set([
  'mode',
  'effort',
  'level',
  'budgetTokens',
  'excludeReasoningOutput',
]);

function validateBaseUrl(value: unknown, field: string): void {
  if (typeof value !== 'string')
    throw new OpenMaicError('CONFIG_ERROR', `${field} must be a URL string.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OpenMaicError('CONFIG_ERROR', `${field} is not a valid URL.`);
  }
  if (url.username || url.password)
    throw new OpenMaicError('CONFIG_ERROR', `${field} must not contain userinfo credentials.`);
  for (const key of url.searchParams.keys()) {
    if (TOKEN_QUERY_KEYS.test(key))
      throw new OpenMaicError(
        'CONFIG_ERROR',
        `${field} must not contain token/key query parameters.`,
      );
  }
}

function validateNoCredentials(value: unknown, path = 'config'): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.test(key))
      throw new OpenMaicError(
        'CONFIG_ERROR',
        `${path}.${key} is forbidden; credentials must come from environment variables.`,
      );
    validateNoCredentials(nested, `${path}.${key}`);
  }
}

export function validateConfig(value: unknown): CliConfigFile {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OpenMaicError('CONFIG_ERROR', 'Configuration must be a JSON object.');
  validateNoCredentials(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!ALLOWED_CONFIG_KEYS.has(key))
      throw new OpenMaicError('CONFIG_ERROR', `Unknown configuration field: ${key}.`);
  }
  const config = value as CliConfigFile;
  if (config.baseUrl !== undefined) validateBaseUrl(config.baseUrl, 'baseUrl');
  if (config.baseUrls !== undefined) {
    if (!config.baseUrls || typeof config.baseUrls !== 'object' || Array.isArray(config.baseUrls))
      throw new OpenMaicError('CONFIG_ERROR', 'baseUrls must be an object.');
    for (const [provider, url] of Object.entries(config.baseUrls))
      validateBaseUrl(url, `baseUrls.${provider}`);
  }
  if (
    config.concurrency !== undefined &&
    (!Number.isInteger(config.concurrency) || config.concurrency < 1 || config.concurrency > 16)
  ) {
    throw new OpenMaicError('CONFIG_ERROR', 'concurrency must be an integer between 1 and 16.');
  }
  for (const field of [
    'model',
    'providerType',
    'documentProvider',
    'searchProvider',
    'imageProvider',
    'videoProvider',
    'ttsProvider',
    'output',
  ] as const) {
    if (config[field] !== undefined && typeof config[field] !== 'string')
      throw new OpenMaicError('CONFIG_ERROR', `${field} must be a string.`);
  }
  if (config.thinking !== undefined) {
    if (!config.thinking || typeof config.thinking !== 'object' || Array.isArray(config.thinking))
      throw new OpenMaicError('CONFIG_ERROR', 'thinking must be an object.');
    for (const key of Object.keys(config.thinking)) {
      if (!ALLOWED_THINKING_KEYS.has(key))
        throw new OpenMaicError('CONFIG_ERROR', `Unknown thinking field: ${key}.`);
    }
  }
  return config;
}

async function readJson(path: string, required: boolean): Promise<CliConfigFile> {
  try {
    return validateConfig(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    if (error instanceof SyntaxError)
      throw new OpenMaicError('CONFIG_ERROR', `Invalid JSON in ${path}: ${error.message}`);
    throw error;
  }
}

function parseEnv(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line
      .slice(0, separator)
      .trim()
      .replace(/^export\s+/, '');
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

export async function loadLocalEnvironment(cwd = process.cwd()): Promise<void> {
  const merged: Record<string, string> = {};
  for (const name of ['.env', '.env.local']) {
    try {
      Object.assign(merged, parseEnv(await readFile(resolve(cwd, name), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  for (const [key, value] of Object.entries(merged))
    if (process.env[key] === undefined) process.env[key] = value;
}

export async function loadConfig(path?: string): Promise<CliConfigFile> {
  return readJson(resolve(path ?? '.openmaicrc.json'), Boolean(path));
}

export function resolveCliModel(
  options: {
    model?: string;
    baseUrl?: string;
    thinking?: ThinkingConfig;
  },
  config: CliConfigFile,
): ModelSelection {
  const modelString = options.model ?? config.model ?? process.env.DEFAULT_MODEL;
  if (!modelString) return resolveModelSelection(undefined);
  const parsed = parseModelString(modelString);
  return resolveModelSelection(modelString, {
    ...parsed,
    providerType: config.providerType,
    baseUrl: options.baseUrl ?? config.baseUrls?.[parsed.providerId] ?? config.baseUrl,
    thinking: options.thinking ?? config.thinking,
  });
}

export function parseThinking(value: string | undefined): ThinkingConfig | undefined {
  if (!value) return undefined;
  if (/^(off|false|disabled)$/i.test(value)) return { mode: 'disabled' };
  if (/^(on|true|enabled)$/i.test(value)) return { mode: 'enabled' };
  if (/^auto$/i.test(value)) return { mode: 'auto' };
  if (/^(none|minimal|low|medium|high|xhigh|max)$/i.test(value))
    return {
      mode: value === 'none' ? 'disabled' : 'enabled',
      effort: value.toLowerCase() as ThinkingConfig['effort'],
    };
  const budget = Number(value);
  if (Number.isInteger(budget) && budget >= -1) return { mode: 'enabled', budgetTokens: budget };
  throw new OpenMaicError('INVALID_ARGUMENT', `Invalid --thinking value: ${value}`);
}
