import { createHash } from 'node:crypto';
import type { SpeechAction } from '@openmaic/dsl';
import {
  createLLMCaller,
  resolveModelSelection,
  type CreateLLMCallerOptions,
  type LLMCaller,
  type ModelSelection,
} from './ai.js';
import { DEFAULT_AGENTS } from './contracts/providers.js';
import {
  GENERATOR_VERSION,
  type CliAgent,
  type CourseGenerationResult,
  type ExtractMaterialsInput,
  type GenerateCourseInput,
  type GenerateOutlineInput,
  type GenerateSceneInput,
  type GenerationWarning,
  type MaterialBundle,
  type OutlineDocument,
  type OutlineGenerationResult,
  type SceneGenerationDocument,
  type SceneGenerationResult,
  type SceneOutline,
} from './contracts/types.js';
import { isAbortError, OpenMaicError, throwIfAborted } from './errors.js';
import { extractMaterials } from './documents/materials.js';
import { generateOutline as runOutline } from './generation/outline.js';
import {
  buildScene,
  createStage,
  generateSceneActions,
  generateSceneContent,
} from './generation/scene.js';
import { withRetry } from './generation/retry.js';
import {
  collectSourceImageAssets,
  generateRequestedMedia,
  resolveImageProvider,
  resolveTtsProvider,
  resolveVideoProvider,
} from './media/index.js';
import { FilePromptRepository, type PromptRepository } from './prompts.js';
import { performWebSearch } from './search/index.js';

export interface OpenMaicGeneratorConfig {
  llm?: LLMCaller;
  model?: ModelSelection;
  modelString?: string;
  prompts?: PromptRepository;
  agents?: CliAgent[];
  documentProviderId?: string;
  searchProviderId?: string;
  imageProviderId?: string;
  videoProviderId?: string;
  ttsProviderId?: string;
  onUsage?: CreateLLMCallerOptions['onUsage'];
  onDebug?: (message: string) => void;
}

export interface OpenMaicGenerator {
  extractMaterials(input: ExtractMaterialsInput): Promise<MaterialBundle>;
  generateOutline(input: GenerateOutlineInput): Promise<OutlineGenerationResult>;
  generateScene(input: GenerateSceneInput): Promise<SceneGenerationResult>;
  generateScenes(input: GenerateSceneInput): Promise<SceneGenerationResult>;
  generateCourse(input: GenerateCourseInput): Promise<CourseGenerationResult>;
}

function withoutMaterialManifest(document: OutlineDocument): Omit<OutlineDocument, 'materials'> {
  const { materials: _materials, ...rest } = document;
  return rest;
}

function resolveOutlineInput(input: OutlineDocument | OutlineGenerationResult): {
  document: Omit<OutlineDocument, 'materials'>;
  materials?: MaterialBundle;
} {
  return 'document' in input
    ? { document: input.document, materials: input.materialBundle }
    : { document: withoutMaterialManifest(input) };
}

function selectOutlines(
  outlines: SceneOutline[],
  selector: GenerateSceneInput['scene'],
): SceneOutline[] {
  if (selector === undefined || selector === 'all') return outlines;
  const numeric =
    typeof selector === 'number' ? selector : /^\d+$/.test(selector) ? Number(selector) : undefined;
  const selected =
    numeric !== undefined
      ? outlines[numeric - 1]
      : outlines.find((outline) => outline.id === selector);
  if (!selected)
    throw new OpenMaicError('INVALID_ARGUMENT', `Scene selector did not match: ${selector}`);
  return [selected];
}

function previousSpeeches(actions: readonly { type: string }[]): string[] {
  return actions.flatMap((action) =>
    action.type === 'speech' ? [(action as SpeechAction).text] : [],
  );
}

function stableCourseId(requirement: string, outlines: readonly SceneOutline[]): string {
  return `course_${createHash('sha256')
    .update(`${requirement}\0${outlines.map((outline) => outline.id).join('\0')}`)
    .digest('hex')
    .slice(0, 20)}`;
}

export function createOpenMaicGenerator(config: OpenMaicGeneratorConfig = {}): OpenMaicGenerator {
  const prompts = config.prompts ?? new FilePromptRepository();
  const agents = (config.agents ?? DEFAULT_AGENTS).map((agent) => ({ ...agent }));
  let llm = config.llm;
  const getLLM = (): LLMCaller => {
    if (!llm) {
      const selection = config.model ?? resolveModelSelection(config.modelString);
      llm = createLLMCaller({ model: selection, onUsage: config.onUsage, onDebug: config.onDebug });
    }
    return llm;
  };

  const generator: OpenMaicGenerator = {
    extractMaterials(input) {
      return extractMaterials({
        ...input,
        providerId: input.providerId ?? config.documentProviderId,
      });
    },

    async generateOutline(input) {
      if (!input.requirement.trim())
        throw new OpenMaicError('INVALID_ARGUMENT', 'Requirement must not be empty.');
      let research = input.research;
      const searchWarnings: GenerationWarning[] = [];
      if (input.webSearch && !research) {
        try {
          research = await performWebSearch({
            requirement: input.requirement,
            materialText: input.materials?.text,
            providerId: config.searchProviderId,
            llm: getLLM(),
            prompts,
            signal: input.signal,
            onProgress: input.onProgress,
          });
        } catch (error) {
          if (input.strictSearch) throw error;
          searchWarnings.push({
            code: 'WEB_SEARCH_FAILED',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const result = await runOutline({ ...input, research }, getLLM(), prompts);
      result.document.warnings.push(...searchWarnings);
      return result;
    },

    async generateScene(input) {
      const restored = resolveOutlineInput(input.outline);
      const source = restored.document;
      const selected = selectOutlines(source.outlines, input.scene);
      const warnings: GenerationWarning[] = [...source.warnings];
      const supported = selected.filter((outline) => {
        if (outline.type !== 'pbl') return true;
        warnings.push({
          code: 'PBL_UNSUPPORTED',
          message: `Skipped unsupported PBL scene "${outline.title}".`,
          sceneId: outline.id,
          sceneTitle: outline.title,
        });
        return false;
      });
      if (!supported.length)
        throw new OpenMaicError(
          'GENERATION_ERROR',
          'No supported scenes remain after filtering PBL outlines.',
        );

      if (input.image) resolveImageProvider(config.imageProviderId);
      if (input.video) resolveVideoProvider(config.videoProviderId);
      if (input.tts) resolveTtsProvider(config.ttsProviderId);

      const stage = createStage(
        source.courseTitle ?? '',
        source.requirement,
        source.languageDirective,
        agents,
      );
      const scenes = [];
      let priorSpeeches: string[] = [];
      const titles = supported.map((outline) => outline.title);
      for (const [index, outline] of supported.entries()) {
        throwIfAborted(input.signal);
        const progress = (phase: 'content' | 'actions' | 'complete' | 'failed') =>
          input.onProgress?.({
            type: 'scene',
            phase,
            current: index + 1,
            total: supported.length,
            sceneId: outline.id,
            title: outline.title,
          });
        try {
          progress('content');
          const content = await withRetry(
            () =>
              generateSceneContent(
                outline,
                restored.materials,
                getLLM(),
                prompts,
                agents,
                source.languageDirective,
                input.signal,
              ),
            { signal: input.signal, retryEmpty: (value) => value === null },
          );
          if (!content)
            throw new OpenMaicError(
              'GENERATION_ERROR',
              `Content generation returned no content for "${outline.title}".`,
            );
          progress('actions');
          const actions = await withRetry(
            () =>
              generateSceneActions(
                outline,
                content,
                getLLM(),
                prompts,
                agents,
                {
                  pageIndex: index + 1,
                  totalPages: supported.length,
                  allTitles: titles,
                  previousSpeeches: priorSpeeches,
                },
                source.languageDirective,
                input.signal,
              ),
            { signal: input.signal },
          );
          scenes.push(buildScene(outline, content, actions, stage.id));
          priorSpeeches = previousSpeeches(actions);
          progress('complete');
        } catch (error) {
          if (input.signal?.aborted || isAbortError(error)) throw error;
          progress('failed');
          warnings.push({
            code: 'SCENE_GENERATION_FAILED',
            message: error instanceof Error ? error.message : String(error),
            sceneId: outline.id,
            sceneTitle: outline.title,
          });
        }
      }
      if (!scenes.length)
        throw new OpenMaicError('GENERATION_ERROR', 'All scene generation attempts failed.');

      const sourceAssets = collectSourceImageAssets(scenes);
      const generated = await generateRequestedMedia(scenes, supported, {
        image: input.image,
        video: input.video,
        tts: input.tts,
        strict: input.strictMedia,
        imageProviderId: config.imageProviderId,
        videoProviderId: config.videoProviderId,
        ttsProviderId: config.ttsProviderId,
        signal: input.signal,
        onProgress: input.onProgress,
      });
      warnings.push(...generated.warnings);
      const assetBlobs = [...sourceAssets, ...generated.assets];
      const now = new Date().toISOString();
      const document: SceneGenerationDocument = {
        kind: 'openmaic-scenes',
        formatVersion: 1,
        generatorVersion: GENERATOR_VERSION,
        id: stableCourseId(source.requirement, supported),
        createdAt: now,
        requirement: source.requirement,
        languageDirective: source.languageDirective,
        courseTitle: source.courseTitle,
        stage,
        outlines: supported,
        scenes,
        agents,
        assets: assetBlobs.map(({ data: _data, ...metadata }) => metadata),
        research: source.research,
        warnings,
      };
      return { document, assetBlobs };
    },

    generateScenes(input) {
      return generator.generateScene({ ...input, scene: input.scene ?? 'all' });
    },

    async generateCourse(input) {
      if (!input.requirement.trim())
        throw new OpenMaicError('INVALID_ARGUMENT', 'Requirement must not be empty.');
      input.onProgress?.({ type: 'preflight', message: 'Validating providers and inputs' });
      getLLM();
      if (input.webSearch) {
        // Resolve before extraction or any paid call.
        const { resolveSearchProvider } = await import('./search/index.js');
        resolveSearchProvider(config.searchProviderId);
      }
      if (input.image) resolveImageProvider(config.imageProviderId);
      if (input.video) resolveVideoProvider(config.videoProviderId);
      if (input.tts) resolveTtsProvider(config.ttsProviderId);
      const materials =
        input.materials ??
        (input.materialPaths?.length
          ? await generator.extractMaterials({
              paths: input.materialPaths,
              signal: input.signal,
              onProgress: input.onProgress,
            })
          : undefined);
      let research;
      const searchWarnings: GenerationWarning[] = [];
      if (input.webSearch) {
        try {
          research = await performWebSearch({
            requirement: input.requirement,
            materialText: materials?.text,
            providerId: config.searchProviderId,
            llm: getLLM(),
            prompts,
            signal: input.signal,
            onProgress: input.onProgress,
          });
        } catch (error) {
          if (input.strictSearch) throw error;
          searchWarnings.push({
            code: 'WEB_SEARCH_FAILED',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const outline = await generator.generateOutline({
        requirement: input.requirement,
        materials,
        research,
        interactiveMode: input.interactiveMode,
        imageGenerationEnabled: input.image,
        videoGenerationEnabled: input.video,
        signal: input.signal,
        onProgress: input.onProgress,
      });
      outline.document.warnings.push(...searchWarnings);
      const scenesResult = await generator.generateScenes({
        outline,
        image: input.image,
        video: input.video,
        tts: input.tts,
        strictMedia: input.strictMedia,
        signal: input.signal,
        onProgress: input.onProgress,
      });
      return {
        document: { ...scenesResult.document, kind: 'openmaic-classroom' },
        assetBlobs: scenesResult.assetBlobs,
      };
    },
  };
  return generator;
}

export interface DoctorCheck {
  id: string;
  ok: boolean;
  message: string;
}

export async function diagnoseConfiguration(
  options: {
    modelString?: string;
    model?: ModelSelection;
    probe?: boolean;
    llm?: LLMCaller;
    onUsage?: CreateLLMCallerOptions['onUsage'];
  } = {},
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  try {
    const model = options.model ?? resolveModelSelection(options.modelString);
    checks.push({
      id: 'model',
      ok: true,
      message: `${model.providerId}:${model.modelId} is configured`,
    });
    if (options.probe) {
      const caller = options.llm ?? createLLMCaller({ model, onUsage: options.onUsage });
      const result = await caller.generate({
        system: 'Reply with exactly OK.',
        user: 'Health check.',
        maxOutputTokens: 64,
      });
      checks.push({
        id: 'probe',
        ok: /ok/i.test(result),
        message: /ok/i.test(result)
          ? 'Model probe succeeded'
          : 'Model probe returned an unexpected response',
      });
    }
  } catch (error) {
    checks.push({
      id: 'model',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  checks.push({
    id: 'node',
    ok: Number(process.versions.node.split('.')[0]) >= 20,
    message: `Node ${process.versions.node}`,
  });
  return checks;
}
