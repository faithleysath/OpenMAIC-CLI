import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { OpenMaicError, redactSensitive } from './errors.js';

export interface NetworkAdapterOptions {
  connectTimeoutMs?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  onDebug?: (message: string) => void;
}

export interface OpenMaicFetchOptions extends RequestInit {
  maxResponseBytes?: number;
  credentialBearing?: boolean;
}

const proxyAgents = new Map<string, ProxyAgent>();

function envProxyFor(url: URL): string | undefined {
  if (shouldBypassProxy(url)) return undefined;
  return url.protocol === 'https:'
    ? (process.env.HTTPS_PROXY ??
        process.env.https_proxy ??
        process.env.HTTP_PROXY ??
        process.env.http_proxy)
    : (process.env.HTTP_PROXY ?? process.env.http_proxy);
}

function shouldBypassProxy(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127\./.test(host)
  ) {
    return true;
  }
  const entries = (process.env.NO_PROXY ?? process.env.no_proxy ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return entries.some((entry) => {
    if (entry === '*') return true;
    const withoutPort = entry.replace(/^\./, '').split(':')[0];
    return host === withoutPort || host.endsWith(`.${withoutPort}`);
  });
}

function dispatcherFor(url: URL): Dispatcher | undefined {
  const proxy = envProxyFor(url);
  if (!proxy) return undefined;
  let agent = proxyAgents.get(proxy);
  if (!agent) {
    agent = new ProxyAgent(proxy);
    proxyAgents.set(proxy, agent);
  }
  return agent;
}

function combinedSignal(signal: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function createNetworkAdapter(options: NetworkAdapterOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const defaultMaxResponseBytes = options.maxResponseBytes ?? 25 * 1024 * 1024;

  return async function openMaicFetch(
    input: string | URL | Request,
    init: OpenMaicFetchOptions = {},
  ): Promise<Response> {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    options.onDebug?.(`HTTP ${init.method ?? 'GET'} ${redactSensitive(url.toString())}`);
    const dispatcher = dispatcherFor(url);
    const response = await undiciFetch(input as string | URL, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
      redirect: init.credentialBearing ? 'manual' : init.redirect,
      signal: combinedSignal(init.signal, timeoutMs),
    });

    const redirect = response.status >= 300 && response.status < 400;
    if (redirect && init.credentialBearing) {
      throw new OpenMaicError(
        'PROVIDER_ERROR',
        `Credential-bearing request refused redirect from ${url.origin}`,
      );
    }

    const maxBytes = init.maxResponseBytes ?? defaultMaxResponseBytes;
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body?.cancel();
      throw new OpenMaicError(
        'PROVIDER_ERROR',
        `Response exceeds ${maxBytes} byte limit from ${url.origin}`,
      );
    }
    return response as unknown as Response;
  };
}

export async function readResponseBuffer(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new OpenMaicError('PROVIDER_ERROR', `Response body exceeds ${maxBytes} byte limit`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function readResponseText(
  response: Response,
  maxBytes = 5 * 1024 * 1024,
): Promise<string> {
  return (await readResponseBuffer(response, maxBytes)).toString('utf8');
}

export async function readResponseJson<T>(response: Response, maxBytes?: number): Promise<T> {
  const text = await readResponseText(response, maxBytes);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new OpenMaicError(
      'PROVIDER_ERROR',
      `Provider returned invalid JSON: ${text.slice(0, 300)}`,
      error,
    );
  }
}
