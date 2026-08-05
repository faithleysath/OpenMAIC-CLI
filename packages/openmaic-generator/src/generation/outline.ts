import { nanoid } from 'nanoid';
import type { LLMCaller } from '../ai.js';
import type {
  GenerateOutlineInput,
  GenerationWarning,
  MaterialImage,
  OutlineGenerationResult,
  SceneOutline,
  SupportedCliSceneType,
} from '../contracts/types.js';
import { GENERATOR_VERSION } from '../contracts/types.js';
import type { PromptRepository } from '../prompts.js';
import { throwIfAborted } from '../errors.js';
import { imageDescription } from './formatters.js';
import { parseJsonResponse } from './json.js';

export const DEFAULT_LANGUAGE_DIRECTIVE =
  'Teach in the language that matches the user requirement.';
const MAX_TEXT_CHARS = 50_000;
const MAX_VISION_IMAGES = 20;
const VALID_TYPES = new Set(['slide', 'quiz', 'interactive', 'pbl']);

interface RawOutlineResponse {
  languageDirective?: string;
  courseTitle?: string;
  outlines?: SceneOutline[];
}

function mediaId(prefix: 'img' | 'vid'): string {
  return `gen_${prefix}_${nanoid(8)}`;
}

function normalizeOutlines(
  raw: unknown[],
  allowed: readonly SupportedCliSceneType[],
  warnings: GenerationWarning[],
): SceneOutline[] {
  const allowedSet = new Set(allowed);
  return raw.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const value = candidate as Record<string, unknown>;
    const type =
      typeof value.type === 'string' && VALID_TYPES.has(value.type) ? value.type : 'slide';
    const title =
      typeof value.title === 'string' && value.title.trim()
        ? value.title.trim()
        : `Scene ${index + 1}`;
    if (type !== 'pbl' && !allowedSet.has(type as SupportedCliSceneType)) {
      warnings.push({
        code: 'UNSUPPORTED_OUTLINE_TYPE',
        message: `Outline "${title}" used disallowed type "${type}" and was normalized to slide.`,
      });
    }
    const normalizedType =
      type === 'pbl' ? 'pbl' : allowedSet.has(type as SupportedCliSceneType) ? type : 'slide';
    const mediaGenerations = Array.isArray(value.mediaGenerations)
      ? value.mediaGenerations.flatMap((media) => {
          if (!media || typeof media !== 'object') return [];
          const entry = media as Record<string, unknown>;
          if (entry.type !== 'image' && entry.type !== 'video') return [];
          return [
            {
              type: entry.type,
              prompt: typeof entry.prompt === 'string' ? entry.prompt : '',
              elementId: mediaId(entry.type === 'video' ? 'vid' : 'img'),
              ...(typeof entry.aspectRatio === 'string' ? { aspectRatio: entry.aspectRatio } : {}),
              ...(typeof entry.duration === 'number' ? { duration: entry.duration } : {}),
            },
          ];
        })
      : undefined;
    return [
      {
        ...value,
        id: typeof value.id === 'string' && value.id ? value.id : nanoid(),
        type: normalizedType,
        title,
        description: typeof value.description === 'string' ? value.description : '',
        keyPoints: Array.isArray(value.keyPoints)
          ? value.keyPoints.filter((point): point is string => typeof point === 'string')
          : [],
        order: index + 1,
        ...(mediaGenerations?.length ? { mediaGenerations } : {}),
      } as SceneOutline,
    ];
  });
}

function visionImages(images: MaterialImage[]): MaterialImage[] {
  return [...images]
    .sort(
      (left, right) =>
        (right.visionPriority ?? 0) - (left.visionPriority ?? 0) ||
        left.pageNumber - right.pageNumber,
    )
    .slice(0, MAX_VISION_IMAGES);
}

export async function generateOutline(
  input: GenerateOutlineInput,
  llm: LLMCaller,
  prompts: PromptRepository,
): Promise<OutlineGenerationResult> {
  throwIfAborted(input.signal);
  input.onProgress?.({ type: 'outline', phase: 'start' });
  const warnings: GenerationWarning[] = [];
  const images = input.materials?.images ?? [];
  const attached = llm.supportsVision === false ? [] : visionImages(images);
  const attachedIds = new Set(attached.map((image) => image.id));
  const allowed = input.allowedSceneTypes ?? ['slide', 'quiz', 'interactive'];
  const prompt = await prompts.build(
    input.interactiveMode ? 'interactive-outlines' : 'requirements-to-outlines',
    {
      requirement: input.requirement,
      pdfContent: input.materials?.text.slice(0, MAX_TEXT_CHARS) || 'None',
      availableImages: images.length
        ? images.map((image) => imageDescription(image, attachedIds.has(image.id))).join('\n')
        : 'No images available',
      userProfile: '',
      hasSourceImages: images.length > 0,
      imageEnabled: input.imageGenerationEnabled ?? false,
      videoEnabled: input.videoGenerationEnabled ?? false,
      mediaEnabled: Boolean(input.imageGenerationEnabled || input.videoGenerationEnabled),
      researchContext: input.research
        ? [
            input.research.answer,
            ...input.research.sources.map(
              (source) => `- [${source.title}](${source.url}): ${source.content}`,
            ),
          ]
            .filter(Boolean)
            .join('\n')
        : 'None',
      teacherContext: '',
    },
  );
  const system = `${prompt.system}\n\nAllowed scene types for this operation: ${allowed.join(', ')}. Do not emit any other scene type.`;
  const response = await llm.generate({
    system,
    user: prompt.user,
    images: attached.map((image) => ({
      id: image.id,
      data: image.data,
      mimeType: image.mimeType,
      width: image.width,
      height: image.height,
    })),
    signal: input.signal,
    maxOutputTokens: llm.outputWindow,
  });
  throwIfAborted(input.signal);
  const parsed = parseJsonResponse<RawOutlineResponse | SceneOutline[]>(response);
  const rawOutlines = Array.isArray(parsed) ? parsed : parsed?.outlines;
  if (!rawOutlines || !Array.isArray(rawOutlines))
    throw new Error('Failed to parse scene outlines response');
  const outlines = normalizeOutlines(rawOutlines, allowed, warnings);
  if (!outlines.length) throw new Error('The model did not return any valid scene outlines');
  input.onProgress?.({ type: 'outline', phase: 'complete' });
  return {
    document: {
      kind: 'openmaic-outline',
      formatVersion: 1,
      generatorVersion: GENERATOR_VERSION,
      requirement: input.requirement,
      courseTitle:
        Array.isArray(parsed) || !parsed?.courseTitle
          ? undefined
          : parsed.courseTitle.trim().slice(0, 120),
      languageDirective:
        Array.isArray(parsed) || !parsed
          ? DEFAULT_LANGUAGE_DIRECTIVE
          : parsed.languageDirective || DEFAULT_LANGUAGE_DIRECTIVE,
      outlines,
      research: input.research,
      warnings,
    },
    materialBundle: input.materials,
  };
}
