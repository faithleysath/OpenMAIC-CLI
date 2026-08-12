import { createHash } from 'node:crypto';
import type { Action, SpeechAction } from '@openmaic/dsl';
import type {
  CliScene,
  GeneratedAssetBlob,
  GenerationWarning,
  MediaGenerationRequest,
  ProgressEvent,
} from '../contracts/types.js';
import { OpenMaicError, throwIfAborted } from '../errors.js';
import {
  createNetworkAdapter,
  readResponseBuffer,
  readResponseJson,
  readResponseText,
} from '../network.js';

interface ProviderDefinition {
  id: string;
  envPrefix: string;
  defaultBaseUrl?: string;
  defaultModel?: string;
  requiresApiKey: boolean;
}

export const IMAGE_PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: 'seedream',
    envPrefix: 'IMAGE_SEEDREAM',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com',
    defaultModel: 'doubao-seedream-5-0-260128',
    requiresApiKey: true,
  },
  {
    id: 'openai-image',
    envPrefix: 'IMAGE_OPENAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-image-1',
    requiresApiKey: true,
  },
  {
    id: 'qwen-image',
    envPrefix: 'IMAGE_QWEN_IMAGE',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com',
    defaultModel: 'qwen-image',
    requiresApiKey: true,
  },
  {
    id: 'nano-banana',
    envPrefix: 'IMAGE_NANO_BANANA',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-2.5-flash-image',
    requiresApiKey: true,
  },
  {
    id: 'minimax-image',
    envPrefix: 'IMAGE_MINIMAX',
    defaultBaseUrl: 'https://api.minimaxi.com',
    defaultModel: 'image-01',
    requiresApiKey: true,
  },
  {
    id: 'grok-image',
    envPrefix: 'IMAGE_GROK',
    defaultBaseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-imagine-image',
    requiresApiKey: true,
  },
  {
    id: 'comfyui-image',
    envPrefix: 'IMAGE_COMFYUI',
    defaultBaseUrl: 'http://localhost:8188',
    requiresApiKey: false,
  },
  {
    id: 'lemonade',
    envPrefix: 'IMAGE_LEMONADE',
    defaultBaseUrl: 'http://localhost:13305/v1',
    defaultModel: 'Qwen-Image-GGUF',
    requiresApiKey: false,
  },
] as const;

export const VIDEO_PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: 'seedance',
    envPrefix: 'VIDEO_SEEDANCE',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-seedance-1-5-pro-251215',
    requiresApiKey: true,
  },
  {
    id: 'kling',
    envPrefix: 'VIDEO_KLING',
    defaultBaseUrl: 'https://api-beijing.klingai.com',
    defaultModel: 'kling-v2-6',
    requiresApiKey: true,
  },
  {
    id: 'veo',
    envPrefix: 'VIDEO_VEO',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    defaultModel: 'veo-3.1-fast-generate-001',
    requiresApiKey: true,
  },
  {
    id: 'minimax-video',
    envPrefix: 'VIDEO_MINIMAX',
    defaultBaseUrl: 'https://api.minimaxi.com',
    defaultModel: 'MiniMax-Hailuo-2.3',
    requiresApiKey: true,
  },
  {
    id: 'grok-video',
    envPrefix: 'VIDEO_GROK',
    defaultBaseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-imagine-video',
    requiresApiKey: true,
  },
  {
    id: 'happyhorse',
    envPrefix: 'VIDEO_HAPPYHORSE',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com',
    defaultModel: 'happyhorse-1.0-t2v',
    requiresApiKey: true,
  },
] as const;

export const TTS_PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: 'openai-tts',
    envPrefix: 'TTS_OPENAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini-tts',
    requiresApiKey: true,
  },
  { id: 'azure-tts', envPrefix: 'TTS_AZURE', requiresApiKey: true },
  {
    id: 'glm-tts',
    envPrefix: 'TTS_GLM',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-tts',
    requiresApiKey: true,
  },
  {
    id: 'qwen-tts',
    envPrefix: 'TTS_QWEN',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com',
    defaultModel: 'qwen3-tts-flash',
    requiresApiKey: true,
  },
  { id: 'voxcpm-tts', envPrefix: 'TTS_VOXCPM', requiresApiKey: false },
  {
    id: 'doubao-tts',
    envPrefix: 'TTS_DOUBAO',
    defaultBaseUrl: 'https://openspeech.bytedance.com/api/v3/tts',
    requiresApiKey: true,
  },
  {
    id: 'elevenlabs-tts',
    envPrefix: 'TTS_ELEVENLABS',
    defaultBaseUrl: 'https://api.elevenlabs.io/v1',
    defaultModel: 'eleven_multilingual_v2',
    requiresApiKey: true,
  },
  {
    id: 'minimax-tts',
    envPrefix: 'TTS_MINIMAX',
    defaultBaseUrl: 'https://api.minimaxi.com/v1',
    defaultModel: 'speech-02-hd',
    requiresApiKey: true,
  },
  {
    id: 'lemonade-tts',
    envPrefix: 'TTS_LEMONADE',
    defaultBaseUrl: 'http://localhost:13305/v1',
    defaultModel: 'kokoro',
    requiresApiKey: false,
  },
] as const;

export interface ResolvedMediaProvider extends ProviderDefinition {
  apiKey?: string;
  baseUrl: string;
  model?: string;
  voice?: string;
}

function resolveProvider(
  definitions: readonly ProviderDefinition[],
  explicit?: string,
): ResolvedMediaProvider {
  const candidates = explicit
    ? definitions.filter((definition) => definition.id === explicit)
    : definitions;
  if (!candidates.length)
    throw new OpenMaicError('CONFIG_ERROR', `Unknown media provider: ${explicit}`);
  for (const definition of candidates) {
    const apiKey = process.env[`${definition.envPrefix}_API_KEY`];
    const baseUrl = process.env[`${definition.envPrefix}_BASE_URL`] ?? definition.defaultBaseUrl;
    if (!baseUrl || (definition.requiresApiKey && !apiKey)) continue;
    return {
      ...definition,
      apiKey,
      baseUrl,
      model: process.env[`${definition.envPrefix}_MODEL`] ?? definition.defaultModel,
      voice: process.env[`${definition.envPrefix}_VOICE`],
    };
  }
  throw new OpenMaicError(
    'PROVIDER_ERROR',
    `${explicit ?? 'Requested media type'} has no provider with complete environment configuration.`,
  );
}

export function resolveImageProvider(explicit?: string): ResolvedMediaProvider {
  if (!process.env.IMAGE_OPENAI_API_KEY && process.env.OPENAI_API_KEY) {
    process.env.IMAGE_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  }
  if (!process.env.IMAGE_OPENAI_BASE_URL && process.env.OPENAI_BASE_URL) {
    process.env.IMAGE_OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
  }
  return resolveProvider(IMAGE_PROVIDERS, explicit);
}
export function resolveVideoProvider(explicit?: string): ResolvedMediaProvider {
  return resolveProvider(VIDEO_PROVIDERS, explicit);
}
export function resolveTtsProvider(explicit?: string): ResolvedMediaProvider {
  return resolveProvider(TTS_PROVIDERS, explicit);
}

function dimensions(aspectRatio = '16:9', width = 1024): { width: number; height: number } {
  const [left, right] = aspectRatio.split(':').map(Number);
  return { width, height: left && right ? Math.round((width * right) / left) : 576 };
}

async function download(
  url: string,
  signal?: AbortSignal,
  maxBytes = 100 * 1024 * 1024,
): Promise<{ data: Buffer; mimeType: string }> {
  const response = await createNetworkAdapter({ timeoutMs: 180_000, maxResponseBytes: maxBytes })(
    url,
    { signal },
  );
  if (!response.ok)
    throw new OpenMaicError('PROVIDER_ERROR', `Asset download failed (${response.status}).`);
  return {
    data: await readResponseBuffer(response, maxBytes),
    mimeType: response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream',
  };
}

async function generateImage(
  provider: ResolvedMediaProvider,
  request: MediaGenerationRequest,
  signal?: AbortSignal,
): Promise<GeneratedAssetBlob> {
  if (provider.id === 'comfyui-image') {
    throw new OpenMaicError(
      'PROVIDER_ERROR',
      'ComfyUI generation requires a workflow and cannot be selected without IMAGE_COMFYUI_WORKFLOW.',
    );
  }
  const size = dimensions(request.aspectRatio);
  const root = provider.baseUrl.replace(/\/+$/, '');
  const providerRoot =
    provider.id === 'seedream' && !/\/api\//.test(root) ? `${root}/api/v3` : root;
  const url = providerRoot.endsWith('/images/generations')
    ? providerRoot
    : `${providerRoot}/images/generations`;
  const body =
    provider.id === 'seedream'
      ? {
          model: provider.model,
          prompt: request.prompt,
          size: '2K',
          watermark: false,
        }
      : {
          model: provider.model,
          prompt: request.prompt,
          size: `${size.width}x${size.height}`,
          response_format: 'b64_json',
        };
  const response = await createNetworkAdapter({ timeoutMs: 180_000 })(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
    credentialBearing: Boolean(provider.apiKey),
  });
  if (!response.ok)
    throw new OpenMaicError(
      'PROVIDER_ERROR',
      `${provider.id} image error (${response.status}): ${(await readResponseText(response)).slice(0, 500)}`,
    );
  const result = await readResponseJson<{
    data?: Array<{ b64_json?: string; url?: string }>;
    images?: Array<{ b64_json?: string; url?: string }>;
  }>(response, 30 * 1024 * 1024);
  const output = (result.data ?? result.images)?.[0];
  const downloaded = output?.b64_json
    ? { data: Buffer.from(output.b64_json, 'base64'), mimeType: 'image/png' }
    : output?.url
      ? await download(output.url, signal, 30 * 1024 * 1024)
      : undefined;
  if (!downloaded) throw new OpenMaicError('PROVIDER_ERROR', `${provider.id} returned no image.`);
  return {
    ref: request.elementId,
    type: 'image',
    mimeType: downloaded.mimeType,
    size: downloaded.data.byteLength,
    prompt: request.prompt,
    data: downloaded.data,
  };
}

async function pollVideoUrl(
  provider: ResolvedMediaProvider,
  taskId: string,
  signal?: AbortSignal,
): Promise<string> {
  const root = provider.baseUrl.replace(/\/+$/, '');
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const response = await createNetworkAdapter()(`${root}/videos/generations/${taskId}`, {
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      signal,
      credentialBearing: true,
    });
    if (!response.ok)
      throw new OpenMaicError(
        'PROVIDER_ERROR',
        `${provider.id} video status error (${response.status}).`,
      );
    const value = await readResponseJson<Record<string, unknown>>(response);
    const status = String(value.status ?? value.state ?? '');
    const url = value.url ?? (value.output as Record<string, unknown> | undefined)?.url;
    if (typeof url === 'string') return url;
    if (/fail|error/i.test(status))
      throw new OpenMaicError('PROVIDER_ERROR', `${provider.id} video generation failed.`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new OpenMaicError('PROVIDER_ERROR', `${provider.id} video generation timed out.`);
}

async function generateVideo(
  provider: ResolvedMediaProvider,
  request: MediaGenerationRequest,
  signal?: AbortSignal,
): Promise<GeneratedAssetBlob> {
  const root = provider.baseUrl.replace(/\/+$/, '');
  const url = root.endsWith('/videos/generations') ? root : `${root}/videos/generations`;
  const response = await createNetworkAdapter({ timeoutMs: 180_000 })(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: provider.model,
      prompt: request.prompt,
      duration: request.duration ?? 6,
      aspect_ratio: request.aspectRatio ?? '16:9',
    }),
    signal,
    credentialBearing: true,
  });
  if (!response.ok)
    throw new OpenMaicError(
      'PROVIDER_ERROR',
      `${provider.id} video error (${response.status}): ${(await readResponseText(response)).slice(0, 500)}`,
    );
  const value = await readResponseJson<Record<string, unknown>>(response);
  const direct = value.url ?? (value.data as Record<string, unknown> | undefined)?.url;
  const taskId =
    value.id ?? value.task_id ?? (value.data as Record<string, unknown> | undefined)?.task_id;
  const assetUrl =
    typeof direct === 'string'
      ? direct
      : typeof taskId === 'string'
        ? await pollVideoUrl(provider, taskId, signal)
        : undefined;
  if (!assetUrl)
    throw new OpenMaicError(
      'PROVIDER_ERROR',
      `${provider.id} returned neither a video URL nor task ID.`,
    );
  const downloaded = await download(assetUrl, signal, 200 * 1024 * 1024);
  return {
    ref: request.elementId,
    type: 'video',
    mimeType: downloaded.mimeType.startsWith('video/') ? downloaded.mimeType : 'video/mp4',
    size: downloaded.data.byteLength,
    prompt: request.prompt,
    duration: request.duration ?? 6,
    data: downloaded.data,
  };
}

function splitConcatenatedJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

async function generateDoubaoTts(
  provider: ResolvedMediaProvider,
  text: string,
  ref: string,
  signal?: AbortSignal,
): Promise<GeneratedAssetBlob> {
  const rawKey = provider.apiKey ?? '';
  const colonIndex = rawKey.indexOf(':');
  const isPlanKey = colonIndex < 0;
  const appId = isPlanKey ? '' : rawKey.slice(0, colonIndex);
  const accessKey = isPlanKey ? '' : rawKey.slice(colonIndex + 1);
  if (!rawKey || (!isPlanKey && (!appId || !accessKey))) {
    throw new OpenMaicError('PROVIDER_ERROR', 'Doubao TTS API key is malformed.');
  }
  const authHeaders: Record<string, string> = isPlanKey
    ? { 'X-Api-Key': rawKey }
    : { 'X-Api-App-Id': appId, 'X-Api-Access-Key': accessKey };
  const response = await createNetworkAdapter({
    timeoutMs: 180_000,
    maxResponseBytes: 25 * 1024 * 1024,
  })(`${provider.baseUrl.replace(/\/+$/, '')}/unidirectional`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
      'X-Api-Resource-Id': 'seed-tts-2.0',
    },
    body: JSON.stringify({
      user: { uid: 'openmaic' },
      req_params: {
        text,
        speaker: provider.voice ?? 'zh_female_vv_uranus_bigtts',
        audio_params: { format: 'mp3', sample_rate: 24_000, speech_rate: 0 },
      },
    }),
    signal,
    credentialBearing: true,
  });
  if (!response.ok) {
    throw new OpenMaicError(
      'PROVIDER_ERROR',
      `doubao-tts error (${response.status}): ${(await readResponseText(response)).slice(0, 500)}`,
    );
  }
  const chunks: Buffer[] = [];
  const responseText = await readResponseText(response, 25 * 1024 * 1024);
  for (const objectText of splitConcatenatedJsonObjects(responseText)) {
    const chunk = JSON.parse(objectText) as { code: number; message?: string; data?: string };
    if (chunk.code === 0 && chunk.data) chunks.push(Buffer.from(chunk.data, 'base64'));
    else if (chunk.code === 20_000_000) break;
    else if (chunk.code) {
      throw new OpenMaicError(
        'PROVIDER_ERROR',
        `doubao-tts error (${chunk.code}): ${chunk.message ?? 'unknown error'}`,
      );
    }
  }
  if (!chunks.length) {
    throw new OpenMaicError('PROVIDER_ERROR', 'Doubao TTS returned no audio data.');
  }
  const data = Buffer.concat(chunks);
  return { ref, type: 'audio', mimeType: 'audio/mpeg', size: data.byteLength, data };
}

async function generateTts(
  provider: ResolvedMediaProvider,
  text: string,
  ref: string,
  signal?: AbortSignal,
): Promise<GeneratedAssetBlob> {
  if (provider.id === 'doubao-tts') {
    return generateDoubaoTts(provider, text, ref, signal);
  }
  const root = provider.baseUrl.replace(/\/+$/, '');
  let url = `${root}/audio/speech`;
  let headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
  let body: string;
  if (provider.id === 'elevenlabs-tts') {
    const voice = provider.voice ?? '21m00Tcm4TlvDq8ikWAM';
    url = `${root}/text-to-speech/${voice}`;
    headers = { ...headers, 'xi-api-key': provider.apiKey ?? '' };
    body = JSON.stringify({ text, model_id: provider.model });
  } else {
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
    body = JSON.stringify({
      model: provider.model,
      input: text,
      voice: provider.voice ?? 'alloy',
      speed: 1,
      response_format: 'mp3',
    });
  }
  const response = await createNetworkAdapter({
    timeoutMs: 180_000,
    maxResponseBytes: 25 * 1024 * 1024,
  })(url, { method: 'POST', headers, body, signal, credentialBearing: Boolean(provider.apiKey) });
  if (!response.ok)
    throw new OpenMaicError(
      'PROVIDER_ERROR',
      `${provider.id} TTS error (${response.status}): ${(await readResponseText(response)).slice(0, 500)}`,
    );
  const data = await readResponseBuffer(response, 25 * 1024 * 1024);
  const mimeType = response.headers.get('content-type')?.split(';')[0] ?? 'audio/mpeg';
  return { ref, type: 'audio', mimeType, size: data.byteLength, data };
}

export interface GenerateMediaOptions {
  image?: boolean;
  video?: boolean;
  tts?: boolean;
  strict?: boolean;
  imageProviderId?: string;
  videoProviderId?: string;
  ttsProviderId?: string;
  /** Injected ports take precedence over env-resolved providers. */
  imagePort?: {
    generate(input: {
      prompt: string;
      elementId: string;
      aspectRatio?: string;
      signal?: AbortSignal;
    }): Promise<GeneratedAssetBlob>;
  };
  videoPort?: {
    generate(input: {
      prompt: string;
      elementId: string;
      duration?: number;
      aspectRatio?: string;
      signal?: AbortSignal;
    }): Promise<GeneratedAssetBlob>;
  };
  ttsPort?: {
    synthesize(input: {
      text: string;
      voiceId?: string;
      speed?: number;
      signal?: AbortSignal;
    }): Promise<GeneratedAssetBlob>;
  };
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
}

export async function generateRequestedMedia(
  scenes: CliScene[],
  outlines: readonly { id: string; mediaGenerations?: MediaGenerationRequest[] }[],
  options: GenerateMediaOptions,
): Promise<{ assets: GeneratedAssetBlob[]; warnings: GenerationWarning[] }> {
  const imageProvider =
    options.image && !options.imagePort
      ? resolveImageProvider(options.imageProviderId)
      : undefined;
  const videoProvider =
    options.video && !options.videoPort
      ? resolveVideoProvider(options.videoProviderId)
      : undefined;
  const ttsProvider =
    options.tts && !options.ttsPort ? resolveTtsProvider(options.ttsProviderId) : undefined;
  const assets: GeneratedAssetBlob[] = [];
  const warnings: GenerationWarning[] = [];
  const run = async (ref: string, operation: () => Promise<GeneratedAssetBlob>) => {
    options.onProgress?.({ type: 'asset', phase: 'start', ref });
    try {
      const asset = await operation();
      assets.push(asset);
      options.onProgress?.({ type: 'asset', phase: 'complete', ref });
    } catch (error) {
      const warning = {
        code: 'MEDIA_GENERATION_FAILED',
        message: `${ref}: ${error instanceof Error ? error.message : String(error)}`,
      };
      warnings.push(warning);
      options.onProgress?.({ type: 'asset', phase: 'failed', ref });
      if (options.strict) throw new OpenMaicError('GENERATION_ERROR', warning.message, error);
    }
  };

  for (const outline of outlines) {
    for (const request of outline.mediaGenerations ?? []) {
      throwIfAborted(options.signal);
      if (request.type === 'image' && (options.imagePort || imageProvider))
        await run(request.elementId, () =>
          options.imagePort
            ? options.imagePort.generate({
                prompt: request.prompt,
                elementId: request.elementId,
                aspectRatio: request.aspectRatio,
                signal: options.signal,
              })
            : generateImage(imageProvider!, request, options.signal),
        );
      if (request.type === 'video' && (options.videoPort || videoProvider))
        await run(request.elementId, () =>
          options.videoPort
            ? options.videoPort.generate({
                prompt: request.prompt,
                elementId: request.elementId,
                duration: request.duration,
                aspectRatio: request.aspectRatio,
                signal: options.signal,
              })
            : generateVideo(videoProvider!, request, options.signal),
        );
    }
  }
  if (options.ttsPort || ttsProvider) {
    for (const scene of scenes) {
      const actions: Action[] = scene.actions ?? [];
      for (const action of actions) {
        if (action.type !== 'speech' || !action.text.trim()) continue;
        const ref = `audio_${createHash('sha256').update(`${scene.id}\0${action.id}\0${action.text}`).digest('hex').slice(0, 20)}`;
        await run(ref, async () => {
          const asset = options.ttsPort
            ? await options.ttsPort.synthesize({
                text: action.text,
                signal: options.signal,
              }).then((blob) => ({ ...blob, ref: blob.ref || ref }))
            : await generateTts(ttsProvider!, action.text, ref, options.signal);
          (action as SpeechAction).audioId = asset.ref || ref;
          return { ...asset, ref: asset.ref || ref };
        });
      }
    }
  }
  return { assets, warnings };
}

export function collectSourceImageAssets(scenes: readonly CliScene[]): GeneratedAssetBlob[] {
  const byHash = new Map<string, GeneratedAssetBlob>();
  for (const scene of scenes) {
    if (scene.content.type !== 'slide') continue;
    for (const element of scene.content.canvas.elements) {
      if (element.type !== 'image' || typeof element.src !== 'string') continue;
      const match = element.src.match(/^data:([^;]+);base64,(.+)$/);
      const mimeType = match?.[1];
      const encoded = match?.[2];
      if (!mimeType || !encoded) continue;
      const data = Buffer.from(encoded, 'base64');
      const hash = createHash('sha256').update(data).digest('hex');
      if (!byHash.has(hash)) {
        byHash.set(hash, {
          ref: `gen_img_source_${hash.slice(0, 24)}`,
          type: 'image',
          mimeType,
          size: data.byteLength,
          data,
        });
      }
    }
  }
  return [...byHash.values()];
}
