import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import type { Action, SpeechAction } from '@openmaic/dsl';
import type {
  CliScene,
  CourseGenerationResult,
  GeneratedAssetBlob,
  SceneGenerationResult,
} from '../contracts/types.js';
import { OpenMaicError } from '../errors.js';
import { writeAtomicFile } from './write.js';

const SAFE_NAME = /[^a-zA-Z0-9._-]+/g;

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

function safeFileName(name: string, mimeType: string): string {
  const cleaned = name.replace(SAFE_NAME, '_').replace(/^_+|_+$/g, '') || 'asset';
  const ext = extension(mimeType);
  return cleaned.includes('.') ? cleaned : `${cleaned}.${ext}`;
}

function assetIdFor(ref: string, data: Buffer): string {
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 16);
  const base = ref.replace(SAFE_NAME, '_').slice(0, 48) || 'asset';
  return `${base}-${hash}`;
}

function rewriteDataUrlToAsset(
  value: string,
  assets: Map<string, GeneratedAssetBlob>,
  byHash: Map<string, string>,
): string {
  const match = value.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return value;
  const mimeType = match[1]!;
  const data = Buffer.from(match[2]!, 'base64');
  const hash = createHash('sha256').update(data).digest('hex');
  const existing = byHash.get(hash);
  if (existing) return `asset://${existing}`;
  const ref = `inline_${hash.slice(0, 20)}`;
  const id = assetIdFor(ref, data);
  assets.set(id, {
    ref: id,
    type: mimeType.startsWith('audio/')
      ? 'audio'
      : mimeType.startsWith('video/')
        ? 'video'
        : 'image',
    mimeType,
    size: data.byteLength,
    data,
  });
  byHash.set(hash, id);
  return `asset://${id}`;
}

function isSlideScene(scene: CliScene): boolean {
  return scene.type === 'slide' && scene.content?.type === 'slide';
}

/**
 * Build a slide-player v1 compatible `.maic` archive.
 * Root entries: manifest.json + document.json + assets/...
 * Only `type: "slide"` scenes are included.
 */
export async function buildPlayerMaicArchive(
  result: SceneGenerationResult | CourseGenerationResult,
  options: { documentId?: string; title?: string } = {},
): Promise<Buffer> {
  const slideScenes = result.document.scenes.filter(isSlideScene);
  if (!slideScenes.length) {
    throw new OpenMaicError(
      'ARCHIVE_ERROR',
      'Player .maic archive requires at least one slide scene.',
    );
  }

  const blobByRef = new Map(result.assetBlobs.map((asset) => [asset.ref, asset]));
  const assets = new Map<string, GeneratedAssetBlob>();
  const byHash = new Map<string, string>();
  const refToAssetId = new Map<string, string>();

  for (const [ref, blob] of blobByRef) {
    const id = assetIdFor(ref, blob.data);
    assets.set(id, { ...blob, ref: id });
    byHash.set(createHash('sha256').update(blob.data).digest('hex'), id);
    refToAssetId.set(ref, id);
  }

  const documentId =
    options.documentId ??
    result.document.id ??
    `doc_${createHash('sha256').update(result.document.requirement).digest('hex').slice(0, 16)}`;
  const title =
    options.title ??
    result.document.courseTitle ??
    result.document.stage.name ??
    'OpenMAIC Lesson';

  const scenes = slideScenes.map((scene, index) => {
    const cloned = structuredClone(scene) as CliScene;
    if (cloned.content.type === 'slide') {
      cloned.content.canvas.elements = cloned.content.canvas.elements.map((element) => {
        if (element.type === 'image' && typeof element.src === 'string') {
          if (element.src.startsWith('data:')) {
            return {
              ...element,
              src: rewriteDataUrlToAsset(element.src, assets, byHash),
            };
          }
          if (refToAssetId.has(element.src)) {
            return { ...element, src: `asset://${refToAssetId.get(element.src)}` };
          }
          if (element.src.startsWith('asset://')) return element;
          // Drop external / unresolved media to satisfy player contract.
          if (/^(?:https?:|media\/|audio\/)/.test(element.src)) {
            return { ...element, src: '' };
          }
        }
        if (element.type === 'video' && typeof (element as { src?: string }).src === 'string') {
          const src = (element as { src: string }).src;
          if (src.startsWith('data:')) {
            return {
              ...element,
              src: rewriteDataUrlToAsset(src, assets, byHash),
            };
          }
          if (refToAssetId.has(src)) {
            return { ...element, src: `asset://${refToAssetId.get(src)}` };
          }
        }
        return element;
      });
    }

    const actions = (cloned.actions ?? []).map((action: Action) => {
      if (action.type !== 'speech') return action;
      const speech = action as SpeechAction;
      if (speech.audioId && refToAssetId.has(speech.audioId)) {
        return { ...speech, audioId: refToAssetId.get(speech.audioId)! };
      }
      return speech;
    });

    return {
      ...cloned,
      order: index,
      type: 'slide' as const,
      actions,
    };
  });

  const now = Date.now();
  const stage = {
    ...result.document.stage,
    id: result.document.stage.id || `stage_${documentId}`,
    createdAt: result.document.stage.createdAt ?? now,
    updatedAt: result.document.stage.updatedAt ?? now,
  };

  const document = {
    kind: 'openmaic-player-document' as const,
    formatVersion: 1 as const,
    dslVersion: '0.1.0' as const,
    id: documentId,
    title,
    stage,
    scenes,
  };

  const manifestAssets: Record<
    string,
    {
      path: string;
      mediaType: string;
      byteLength: number;
      sha256: string;
      durationSeconds?: number;
      width?: number;
      height?: number;
    }
  > = {};

  const zip = new JSZip();
  for (const [id, asset] of assets) {
    const fileName = safeFileName(id, asset.mimeType);
    const path = `assets/${id}/${fileName}`;
    zip.file(path, asset.data);
    const sha256 = createHash('sha256').update(asset.data).digest('hex');
    manifestAssets[id] = {
      path,
      mediaType: asset.mimeType,
      byteLength: asset.data.byteLength,
      sha256,
      ...(typeof asset.duration === 'number' ? { durationSeconds: asset.duration } : {}),
    };
  }

  const manifest = {
    kind: 'openmaic-player-archive' as const,
    formatVersion: 1 as const,
    entry: 'document.json' as const,
    documentId,
    title,
    language: result.document.languageDirective || result.document.stage.languageDirective || 'zh-CN',
    assets: manifestAssets,
  };

  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('document.json', JSON.stringify(document, null, 2));

  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

export async function writePlayerMaicArchive(
  result: SceneGenerationResult | CourseGenerationResult,
  path: string,
  options: { force?: boolean; signal?: AbortSignal; documentId?: string; title?: string } = {},
): Promise<void> {
  const buffer = await buildPlayerMaicArchive(result, options);
  // Ensure final name can be lesson.maic (caller responsibility); bytes are pure zip.
  await writeAtomicFile(path, buffer, options);
}
