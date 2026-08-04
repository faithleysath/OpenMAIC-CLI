import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import type {
  MaterialBundle,
  MaterialImage,
  MaterialSnapshotEntry,
  OutlineDocument,
  OutlineGenerationResult,
} from '../contracts/types.js';
import { OpenMaicError } from '../errors.js';
import { writeAtomicFile } from './write.js';

const MAX_OUTLINE_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function extensionFor(mimeType: string): string {
  return (
    (
      {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'image/bmp': 'bmp',
      } as Record<string, string>
    )[mimeType] ?? 'bin'
  );
}

function safeEntryPath(path: string): boolean {
  return !path.startsWith('/') && !path.includes('\\') && !path.split('/').includes('..');
}

export async function buildOutlineBundle(result: OutlineGenerationResult): Promise<Buffer> {
  const zip = new JSZip();
  const entries: MaterialSnapshotEntry[] = [];
  for (const image of result.materialBundle?.images ?? []) {
    const directory = image.kind === 'keyframe' ? 'materials/keyframes' : 'materials/images';
    const hash = sha256(image.data);
    const path = `${directory}/${image.id}_${hash.slice(0, 12)}.${extensionFor(image.mimeType)}`;
    zip.file(path, image.data);
    entries.push({
      id: image.id,
      kind: image.kind ?? 'image',
      mimeType: image.mimeType,
      size: image.data.byteLength,
      sha256: hash,
      path,
      pageNumber: image.pageNumber,
      timeMs: image.timeMs,
      width: image.width,
      height: image.height,
      description: image.description,
      sourceDocumentId: image.sourceDocumentId,
      sourceDocumentName: image.sourceDocumentName,
      sourceDocumentOrder: image.sourceDocumentOrder,
      visionPriority: image.visionPriority,
    });
  }
  const document: OutlineDocument = {
    ...result.document,
    ...(result.materialBundle
      ? {
          materials: {
            text: result.materialBundle.text,
            totalRawTextLength: result.materialBundle.totalRawTextLength,
            entries,
          },
        }
      : {}),
  };
  zip.file('outline.json', JSON.stringify(document, null, 2));
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

export async function writeOutlineBundle(
  result: OutlineGenerationResult,
  path: string,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  await writeAtomicFile(path, await buildOutlineBundle(result), options);
}

export async function readOutlineInput(
  path: string,
): Promise<{ document: OutlineDocument; materials?: MaterialBundle }> {
  const zip = await JSZip.loadAsync(await readFile(path), { checkCRC32: true });
  for (const name of Object.keys(zip.files)) {
    if (!safeEntryPath(name))
      throw new OpenMaicError('ARCHIVE_ERROR', `Unsafe ZIP entry path: ${name}`);
  }
  const outlineEntry = zip.file('outline.json');
  if (!outlineEntry)
    throw new OpenMaicError('ARCHIVE_ERROR', 'Outline bundle does not contain outline.json.');
  const document = JSON.parse(await outlineEntry.async('string')) as OutlineDocument;
  if (
    document.kind !== 'openmaic-outline' ||
    document.formatVersion !== 1 ||
    !Array.isArray(document.outlines)
  ) {
    throw new OpenMaicError('ARCHIVE_ERROR', 'Unsupported or invalid outline document.');
  }
  if (!document.materials) return { document };
  let total = Buffer.byteLength(document.materials.text, 'utf8');
  const images: MaterialImage[] = [];
  for (const metadata of document.materials.entries) {
    if (!safeEntryPath(metadata.path))
      throw new OpenMaicError('ARCHIVE_ERROR', `Unsafe material path: ${metadata.path}`);
    const entry = zip.file(metadata.path);
    if (!entry)
      throw new OpenMaicError('ARCHIVE_ERROR', `Missing material entry: ${metadata.path}`);
    const data = await entry.async('nodebuffer');
    total += data.byteLength;
    if (total > MAX_OUTLINE_UNCOMPRESSED_BYTES)
      throw new OpenMaicError(
        'ARCHIVE_ERROR',
        'Outline bundle exceeds the uncompressed size limit.',
      );
    if (data.byteLength !== metadata.size || sha256(data) !== metadata.sha256) {
      throw new OpenMaicError('ARCHIVE_ERROR', `Material hash or size mismatch: ${metadata.path}`);
    }
    images.push({
      id: metadata.id,
      kind: metadata.kind,
      mimeType: metadata.mimeType,
      data,
      pageNumber: metadata.pageNumber ?? 1,
      timeMs: metadata.timeMs,
      width: metadata.width,
      height: metadata.height,
      description: metadata.description,
      sourceDocumentId: metadata.sourceDocumentId,
      sourceDocumentName: metadata.sourceDocumentName,
      sourceDocumentOrder: metadata.sourceDocumentOrder,
      visionPriority: metadata.visionPriority,
    });
  }
  return {
    document,
    materials: {
      text: document.materials.text,
      images,
      totalRawTextLength: document.materials.totalRawTextLength,
      totalImageCount: images.length,
      visionImageCount: images.filter((image) => (image.visionPriority ?? 0) > 0).length,
    },
  };
}
