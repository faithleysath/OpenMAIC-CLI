import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import type { Action, SpeechAction } from '@openmaic/dsl';
import type {
  CliScene,
  CourseGenerationResult,
  SceneGenerationResult,
} from '../contracts/types.js';
import { writeAtomicFile } from './write.js';
import { inlineHtmlAssets } from './inline-assets.js';

type ManifestAction = Omit<Action, 'audioId'> & { audioRef?: string };
interface ManifestScene {
  type: CliScene['type'];
  title: string;
  order: number;
  content: CliScene['content'];
  actions?: ManifestAction[];
}

function extension(mimeType: string): string {
  const known: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/webm': 'webm',
  };
  return known[mimeType] ?? mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') ?? 'bin';
}

function cloneScene(scene: CliScene): CliScene {
  return structuredClone(scene);
}

function sourceRef(dataUrl: string): string {
  const encoded = dataUrl.match(/^data:[^;]+;base64,(.+)$/)?.[1];
  if (!encoded) throw new Error('Invalid source image data URL');
  return `gen_img_source_${createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('hex').slice(0, 24)}`;
}

export async function buildMaicArchive(
  result: SceneGenerationResult | CourseGenerationResult,
  signal?: AbortSignal,
): Promise<Buffer> {
  const zip = new JSZip();
  const assets = new Map(result.assetBlobs.map((asset) => [asset.ref, asset]));
  const mediaIndex: Record<string, Record<string, unknown>> = {};
  const audioPaths = new Map<string, string>();
  const mediaPaths = new Map<string, string>();
  for (const asset of assets.values()) {
    const path = `${asset.type === 'audio' ? 'audio' : 'media'}/${asset.ref}.${extension(asset.mimeType)}`;
    zip.file(path, asset.data);
    if (asset.type === 'audio') audioPaths.set(asset.ref, path);
    else mediaPaths.set(asset.ref, path);
    mediaIndex[path] = {
      type:
        asset.type === 'audio'
          ? 'audio'
          : asset.ref.startsWith('gen_img_source_')
            ? 'image'
            : 'generated',
      mimeType: asset.mimeType,
      size: asset.size,
      prompt: asset.prompt,
      duration: asset.duration,
    };
  }
  for (const outline of result.document.outlines) {
    for (const request of outline.mediaGenerations ?? []) {
      if (mediaPaths.has(request.elementId)) continue;
      mediaIndex[`media/${request.elementId}.${request.type === 'video' ? 'mp4' : 'png'}`] = {
        type: 'generated',
        mimeType: request.type === 'video' ? 'video/mp4' : 'image/png',
        prompt: request.prompt,
        missing: true,
      };
    }
  }
  const inlineFailures: string[] = [];
  const manifestScenes: ManifestScene[] = [];
  for (const original of result.document.scenes) {
    const scene = cloneScene(original);
    if (scene.content.type === 'slide') {
      scene.content.canvas.elements = scene.content.canvas.elements.map((element) => {
        if (
          element.type === 'image' &&
          typeof element.src === 'string' &&
          /^data:image\//.test(element.src)
        ) {
          return { ...element, src: sourceRef(element.src) };
        }
        return element;
      });
    } else if (scene.content.type === 'interactive' && scene.content.html) {
      const inlined = await inlineHtmlAssets(scene.content.html, signal);
      scene.content.html = inlined.html;
      inlineFailures.push(
        ...inlined.report.failed.map((failure) => `${failure.url}: ${failure.reason}`),
      );
    }
    const actions = scene.actions?.map((action) => {
      if (action.type !== 'speech') return action as ManifestAction;
      const { audioId, ...rest } = action as SpeechAction;
      return {
        ...rest,
        ...(audioId && audioPaths.has(audioId) ? { audioRef: audioPaths.get(audioId) } : {}),
      } as ManifestAction;
    });
    manifestScenes.push({
      type: scene.type,
      title: scene.title,
      order: scene.order,
      content: scene.content,
      actions,
    });
  }
  for (const scene of result.document.scenes) {
    for (const action of scene.actions ?? []) {
      if (action.type === 'speech' && action.audioId && !audioPaths.has(action.audioId)) {
        mediaIndex[`audio/${action.audioId}.mp3`] = { type: 'audio', missing: true };
      }
    }
  }
  const manifest = {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    appVersion: result.document.generatorVersion,
    stage: {
      name: result.document.stage.name,
      description: result.document.stage.description,
      language: result.document.stage.languageDirective,
      style: result.document.stage.style,
      createdAt: result.document.stage.createdAt,
      updatedAt: result.document.stage.updatedAt,
    },
    agents: result.document.agents.map(({ name, role, persona, avatar, color, priority }) => ({
      name,
      role,
      persona,
      avatar,
      color,
      priority,
    })),
    scenes: manifestScenes,
    mediaIndex,
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file(
    'generation.json',
    JSON.stringify(
      {
        kind: result.document.kind,
        formatVersion: result.document.formatVersion,
        generatorVersion: result.document.generatorVersion,
        requirement: result.document.requirement,
        languageDirective: result.document.languageDirective,
        courseTitle: result.document.courseTitle,
        outlines: result.document.outlines,
        research: result.document.research,
        warnings: [
          ...result.document.warnings,
          ...inlineFailures.map((message) => ({
            code: 'INTERACTIVE_ASSET_INLINE_FAILED',
            message,
          })),
        ],
      },
      null,
      2,
    ),
  );
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

export async function writeMaicArchive(
  result: SceneGenerationResult | CourseGenerationResult,
  path: string,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  await writeAtomicFile(path, await buildMaicArchive(result, options.signal), options);
}
