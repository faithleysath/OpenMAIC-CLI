import type { LLMCaller } from '../ai.js';
import type { ResearchSnapshot, ResearchSource } from '../contracts/types.js';
import { OpenMaicError, throwIfAborted } from '../errors.js';
import { createNetworkAdapter, readResponseJson, readResponseText } from '../network.js';
import type { PromptRepository } from '../prompts.js';
import { parseJsonResponse } from '../generation/json.js';

export type WebSearchProviderId =
  | 'tavily'
  | 'bocha'
  | 'brave'
  | 'baidu'
  | 'minimax'
  | 'doubao'
  | 'searxng';

interface ProviderConfig {
  id: WebSearchProviderId;
  apiKey?: string;
  baseUrl?: string;
}

const SEARCH_ORDER: readonly WebSearchProviderId[] = [
  'tavily',
  'bocha',
  'brave',
  'baidu',
  'minimax',
  'doubao',
  'searxng',
];

const ENV: Record<WebSearchProviderId, { key?: string; base?: string; defaultBase?: string }> = {
  tavily: { key: 'TAVILY_API_KEY', base: 'TAVILY_BASE_URL', defaultBase: 'https://api.tavily.com' },
  bocha: { key: 'BOCHA_API_KEY', base: 'BOCHA_BASE_URL', defaultBase: 'https://api.bocha.cn' },
  brave: { key: 'BRAVE_API_KEY', base: 'BRAVE_BASE_URL', defaultBase: 'https://search.brave.com' },
  baidu: {
    key: 'BAIDU_API_KEY',
    base: 'BAIDU_BASE_URL',
    defaultBase: 'https://qianfan.baidubce.com',
  },
  minimax: {
    key: 'WEB_SEARCH_MINIMAX_API_KEY',
    base: 'WEB_SEARCH_MINIMAX_BASE_URL',
    defaultBase: 'https://api.minimaxi.com',
  },
  doubao: {
    key: 'WEB_SEARCH_DOUBAO_API_KEY',
    base: 'WEB_SEARCH_DOUBAO_BASE_URL',
    defaultBase: 'https://open.feedcoopapi.com',
  },
  searxng: { base: 'SEARXNG_BASE_URL' },
};

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim();
}

function configFor(id: WebSearchProviderId): ProviderConfig | undefined {
  const env = ENV[id];
  const apiKey = env.key ? process.env[env.key] : undefined;
  const baseUrl = (env.base ? process.env[env.base] : undefined) ?? env.defaultBase;
  if (id === 'searxng' && !baseUrl) return undefined;
  if (!['brave', 'searxng'].includes(id) && !apiKey) return undefined;
  return { id, apiKey, baseUrl };
}

export function resolveSearchProvider(explicit?: string): ProviderConfig {
  if (explicit) {
    if (!SEARCH_ORDER.includes(explicit as WebSearchProviderId))
      throw new OpenMaicError('CONFIG_ERROR', `Unknown search provider: ${explicit}`);
    const config = configFor(explicit as WebSearchProviderId);
    if (!config)
      throw new OpenMaicError(
        'PROVIDER_ERROR',
        `Search provider ${explicit} is missing required environment configuration.`,
      );
    return config;
  }
  for (const id of SEARCH_ORDER) {
    const config = configFor(id);
    if (config) return config;
  }
  throw new OpenMaicError('PROVIDER_ERROR', 'No web search provider is configured.');
}

async function responseError(provider: string, response: Response): Promise<never> {
  throw new OpenMaicError(
    'PROVIDER_ERROR',
    `${provider} search error (${response.status}): ${(await readResponseText(response)).slice(0, 500) || response.statusText}`,
  );
}

async function tavily(
  config: ProviderConfig,
  query: string,
  signal?: AbortSignal,
): Promise<ResearchSource[]> {
  const root = config.baseUrl!.replace(/\/+$/, '');
  const url = root.endsWith('/search') ? root : `${root}/search`;
  const response = await createNetworkAdapter()(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: query.slice(0, 400),
      search_depth: 'basic',
      max_results: 8,
      include_answer: 'basic',
    }),
    signal,
    credentialBearing: true,
  });
  if (!response.ok) return responseError('Tavily', response);
  const data = await readResponseJson<{
    results?: Array<{ title?: string; url?: string; content?: string; score?: number }>;
  }>(response);
  return (data.results ?? [])
    .filter((item) => item.url)
    .map((item) => ({
      title: item.title ?? item.url!,
      url: item.url!,
      content: item.content ?? '',
      score: item.score ?? 0,
    }));
}

async function bocha(
  config: ProviderConfig,
  query: string,
  signal?: AbortSignal,
): Promise<ResearchSource[]> {
  const root = config.baseUrl!.replace(/\/+$/, '');
  const url = root.endsWith('/v1/web-search')
    ? root
    : root.endsWith('/v1')
      ? `${root}/web-search`
      : `${root}/v1/web-search`;
  const response = await createNetworkAdapter()(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, freshness: 'noLimit', summary: true, count: 10 }),
    signal,
    credentialBearing: true,
  });
  if (!response.ok) return responseError('Bocha', response);
  const raw = await readResponseJson<{
    code?: number | string;
    message?: string;
    data?: {
      webPages?: {
        value?: Array<{ name?: string; url?: string; summary?: string; snippet?: string }>;
      };
    };
    webPages?: {
      value?: Array<{ name?: string; url?: string; summary?: string; snippet?: string }>;
    };
  }>(response);
  if (raw.code !== undefined && String(raw.code) !== '200')
    throw new OpenMaicError(
      'PROVIDER_ERROR',
      `Bocha search error (${raw.code}): ${raw.message ?? 'request failed'}`,
    );
  const pages = raw.data?.webPages?.value ?? raw.webPages?.value ?? [];
  return pages
    .filter((item) => item.url)
    .map((item) => ({
      title: item.name ?? item.url!,
      url: item.url!,
      content: item.summary ?? item.snippet ?? '',
      score: 0,
    }));
}

function decodeHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function brave(
  config: ProviderConfig,
  query: string,
  signal?: AbortSignal,
): Promise<ResearchSource[]> {
  const fetcher = createNetworkAdapter();
  if (config.apiKey) {
    const url = new URL('/res/v1/web/search', 'https://api.search.brave.com');
    url.searchParams.set('q', query);
    url.searchParams.set('count', '8');
    const response = await fetcher(url, {
      headers: { 'X-Subscription-Token': config.apiKey, Accept: 'application/json' },
      signal,
      credentialBearing: true,
    });
    if (!response.ok) return responseError('Brave', response);
    const data = await readResponseJson<{
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    }>(response);
    return (data.web?.results ?? [])
      .filter((item) => item.url)
      .map((item, index) => ({
        title: item.title ?? item.url!,
        url: item.url!,
        content: decodeHtml(item.description ?? ''),
        score: 1 - index * 0.05,
      }));
  }
  const url = new URL(`${config.baseUrl!.replace(/\/+$/, '')}/search`);
  url.searchParams.set('q', query);
  const response = await fetcher(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OpenMAIC/1.0)' },
    signal,
  });
  if (!response.ok) return responseError('Brave', response);
  const html = await readResponseText(response, 5 * 1024 * 1024);
  return [
    ...html.matchAll(
      /<a[^>]+href="(https?:\/\/[^"#]+)"[^>]*>[\s\S]*?<[^>]*class="[^"]*search-snippet-title[^"]*"[^>]*>([\s\S]*?)<\//gi,
    ),
  ]
    .slice(0, 8)
    .flatMap((match, index) =>
      match[1] && match[2]
        ? [{ title: decodeHtml(match[2]), url: match[1], content: '', score: 1 - index * 0.1 }]
        : [],
    );
}

async function baidu(
  config: ProviderConfig,
  query: string,
  signal?: AbortSignal,
): Promise<ResearchSource[]> {
  const root = config.baseUrl!.replace(/\/+$/, '');
  const response = await createNetworkAdapter()(`${root}/v2/ai_search/web_search`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'X-Appbuilder-From': 'openmaic',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: [{ content: query, role: 'user' }],
      search_source: 'baidu_search_v2',
      resource_type_filter: [{ type: 'web', top_k: 10 }],
    }),
    signal,
    credentialBearing: true,
  });
  if (!response.ok) return responseError('Baidu', response);
  const data = await readResponseJson<{
    code?: number;
    message?: string;
    references?: Array<{ title?: string; url?: string; site_name?: string; content?: string }>;
  }>(response);
  if (data.code && data.code !== 0)
    throw new OpenMaicError(
      'PROVIDER_ERROR',
      `Baidu search error (${data.code}): ${data.message ?? 'request failed'}`,
    );
  return (data.references ?? [])
    .filter((item) => item.url)
    .map((item, index) => ({
      title: item.title ?? item.site_name ?? item.url!,
      url: item.url!,
      content: item.content ?? '',
      score: 0.9 - index * 0.05,
    }));
}

async function minimax(
  config: ProviderConfig,
  query: string,
  signal?: AbortSignal,
): Promise<ResearchSource[]> {
  const root = config.baseUrl!.replace(/\/+$/, '');
  const url = root.endsWith('/v1/coding_plan/search') ? root : `${root}/v1/coding_plan/search`;
  const response = await createNetworkAdapter()(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'MM-API-Source': 'OpenMAIC',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q: query }),
    signal,
    credentialBearing: true,
  });
  if (!response.ok) return responseError('MiniMax', response);
  const data = await readResponseJson<{
    organic?: Array<Record<string, unknown>>;
    results?: Array<Record<string, unknown>>;
    data?: { organic?: Array<Record<string, unknown>> };
  }>(response);
  return (data.organic ?? data.data?.organic ?? data.results ?? []).flatMap((item) => {
    const url = String(item.link ?? item.url ?? '');
    return url
      ? [
          {
            title: String(item.title ?? url),
            url,
            content: String(item.snippet ?? item.summary ?? item.content ?? ''),
            score: 0,
          },
        ]
      : [];
  });
}

async function doubao(
  config: ProviderConfig,
  query: string,
  signal?: AbortSignal,
): Promise<ResearchSource[]> {
  const root = config.baseUrl!.replace(/\/+$/, '');
  const url = root.endsWith('/search_api/web_search') ? root : `${root}/search_api/web_search`;
  const response = await createNetworkAdapter()(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Query: query.slice(0, 100),
      SearchType: 'web',
      Count: 10,
      NeedSummary: true,
    }),
    signal,
    credentialBearing: true,
  });
  if (!response.ok) return responseError('Doubao', response);
  const data = await readResponseJson<{
    ResponseMetadata?: { Error?: { Code?: string; Message?: string } };
    Result?: {
      WebResults?: Array<{
        Title?: string;
        Url?: string;
        Summary?: string;
        Content?: string;
        Snippet?: string;
        RankScore?: number;
      }>;
    };
  }>(response);
  if (data.ResponseMetadata?.Error)
    throw new OpenMaicError(
      'PROVIDER_ERROR',
      `Doubao search error (${data.ResponseMetadata.Error.Code ?? 'unknown'}): ${data.ResponseMetadata.Error.Message ?? 'request failed'}`,
    );
  return (data.Result?.WebResults ?? [])
    .filter((item) => item.Url)
    .map((item) => ({
      title: item.Title ?? item.Url!,
      url: item.Url!,
      content: item.Summary ?? item.Content ?? item.Snippet ?? '',
      score: item.RankScore ?? 0,
    }));
}

async function searxng(
  config: ProviderConfig,
  query: string,
  signal?: AbortSignal,
): Promise<ResearchSource[]> {
  const root = config.baseUrl!.replace(/\/+$/, '').replace(/\/search$/, '');
  const url = new URL(`${root}/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  const response = await createNetworkAdapter()(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'OpenMAIC/1.0' },
    signal,
  });
  if (!response.ok) return responseError('SearXNG', response);
  const data = await readResponseJson<{
    results?: Array<{ title?: string; url?: string; content?: string; score?: number }>;
  }>(response);
  return (data.results ?? [])
    .filter((item) => item.url)
    .map((item, index) => ({
      title: item.title ?? item.url!,
      url: item.url!,
      content: item.content ?? '',
      score: item.score ?? 1 - index * 0.05,
    }));
}

async function search(
  config: ProviderConfig,
  query: string,
  signal?: AbortSignal,
): Promise<ResearchSource[]> {
  switch (config.id) {
    case 'tavily':
      return tavily(config, query, signal);
    case 'bocha':
      return bocha(config, query, signal);
    case 'brave':
      return brave(config, query, signal);
    case 'baidu':
      return baidu(config, query, signal);
    case 'minimax':
      return minimax(config, query, signal);
    case 'doubao':
      return doubao(config, query, signal);
    case 'searxng':
      return searxng(config, query, signal);
  }
}

export async function performWebSearch(input: {
  requirement: string;
  materialText?: string;
  providerId?: string;
  llm: LLMCaller;
  prompts: PromptRepository;
  signal?: AbortSignal;
  onProgress?: (event: { type: 'search'; providerId: string; query: string }) => void;
}): Promise<ResearchSnapshot> {
  throwIfAborted(input.signal);
  const config = resolveSearchProvider(input.providerId);
  const rewritePrompt = await input.prompts.build('web-search-query-rewrite', {
    requirement: input.requirement,
    pdfExcerpt: input.materialText?.slice(0, 4_000) ?? 'None',
  });
  const rewritten = await input.llm.generate({
    system: rewritePrompt.system,
    user: rewritePrompt.user,
    signal: input.signal,
    maxOutputTokens: 512,
  });
  const parsed = parseJsonResponse<{ query?: string } | string>(rewritten);
  const query = normalizeQuery(
    typeof parsed === 'string' ? parsed : (parsed?.query ?? input.requirement),
  ).slice(0, 400);
  input.onProgress?.({ type: 'search', providerId: config.id, query });
  const sources = await search(config, query, input.signal);
  return { providerId: config.id, query, sources };
}

export function formatSearchResultsAsContext(snapshot: ResearchSnapshot): string {
  return [
    snapshot.answer,
    snapshot.sources.length ? 'Sources:' : '',
    ...snapshot.sources.map(
      (source) => `- [${source.title}](${source.url}): ${source.content.slice(0, 200)}`,
    ),
  ]
    .filter(Boolean)
    .join('\n');
}
