import type { LLMCaller } from '../ai.js';
import type { GeneratedAssetBlob, ResearchSnapshot } from './types.js';

/** Versioned operation keys shared with HXR ai-execution-contract. */
export type OpenMaicOperationKey =
  | 'openmaic.outline.query_rewrite'
  | 'openmaic.outline.generate'
  | 'openmaic.scene.slide.content'
  | 'openmaic.scene.quiz.content'
  | 'openmaic.scene.interactive.content'
  | 'openmaic.scene.slide.actions'
  | 'openmaic.search.web'
  | 'openmaic.media.image.prompt'
  | 'openmaic.media.image.generate'
  | 'openmaic.media.video.prompt'
  | 'openmaic.media.video.generate'
  | 'openmaic.media.tts';

export const OPENMAIC_OPERATION_KEYS = [
  'openmaic.outline.query_rewrite',
  'openmaic.outline.generate',
  'openmaic.scene.slide.content',
  'openmaic.scene.quiz.content',
  'openmaic.scene.interactive.content',
  'openmaic.scene.slide.actions',
  'openmaic.search.web',
  'openmaic.media.image.prompt',
  'openmaic.media.image.generate',
  'openmaic.media.video.prompt',
  'openmaic.media.video.generate',
  'openmaic.media.tts',
] as const satisfies readonly OpenMaicOperationKey[];

export interface SearchProvider {
  search(input: {
    query: string;
    requirement?: string;
    signal?: AbortSignal;
  }): Promise<ResearchSnapshot>;
}

export interface ImageProvider {
  generate(input: {
    prompt: string;
    elementId: string;
    aspectRatio?: string;
    signal?: AbortSignal;
  }): Promise<GeneratedAssetBlob>;
}

export interface VideoProvider {
  generate(input: {
    prompt: string;
    elementId: string;
    duration?: number;
    aspectRatio?: string;
    signal?: AbortSignal;
  }): Promise<GeneratedAssetBlob>;
}

export interface TtsProvider {
  synthesize(input: {
    text: string;
    voiceId?: string;
    speed?: number;
    signal?: AbortSignal;
  }): Promise<GeneratedAssetBlob>;
}

/**
 * Host-injected provider ports. HXR injects Gateway-backed implementations;
 * the standalone CLI may keep env-based adapters.
 */
export interface OpenMaicProviderPorts {
  llm(operationKey: OpenMaicOperationKey): LLMCaller;
  search(operationKey: OpenMaicOperationKey): SearchProvider;
  image(operationKey: OpenMaicOperationKey): ImageProvider;
  video(operationKey: OpenMaicOperationKey): VideoProvider;
  tts(operationKey: OpenMaicOperationKey): TtsProvider;
}

export interface OpenMaicCallObserver {
  onCallStart?(event: {
    operationId: string;
    kind: string;
    providerId?: string;
    modelId?: string;
  }): void | Promise<void>;
  onCallFinish?(event: {
    operationId: string;
    callId?: string;
    durationMs: number;
    status: 'succeeded' | 'accepted';
  }): void | Promise<void>;
  onCallError?(event: {
    operationId: string;
    callId?: string;
    durationMs: number;
    errorCode: string;
  }): void | Promise<void>;
}

export function isOpenMaicOperationKey(value: string): value is OpenMaicOperationKey {
  return (OPENMAIC_OPERATION_KEYS as readonly string[]).includes(value);
}
