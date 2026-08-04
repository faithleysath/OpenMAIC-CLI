import { basename, extname } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import type { ExtractMaterialsInput, MaterialBundle, MaterialImage } from '../contracts/types.js';
import { OpenMaicError, throwIfAborted } from '../errors.js';
import {
  createNetworkAdapter,
  readResponseBuffer,
  readResponseJson,
  readResponseText,
} from '../network.js';

export const MAX_DOCUMENT_BUNDLE_FILES = 5;
export const MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES = 150 * 1024 * 1024;
const MAX_TEXT_CHARS = 50_000;
const MAX_VISION_IMAGES = 20;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.jp2': 'image/jp2',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.wmv': 'video/x-ms-wmv',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
};

const MINERU_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/jp2',
]);

interface ParsedPart {
  sourceId: string;
  name: string;
  order: number;
  mimeType: string;
  text: string;
  images: Array<
    Omit<
      MaterialImage,
      'sourceDocumentId' | 'sourceDocumentName' | 'sourceDocumentOrder' | 'visionPriority'
    >
  >;
}

function decodeText(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer);
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer);
  return new TextDecoder('utf-8').decode(buffer);
}

function providerFor(mimeType: string, explicit?: string): string {
  if (mimeType === 'text/plain' || mimeType === 'text/markdown') return 'plain-text';
  if (explicit) return explicit;
  if (mimeType === 'application/pdf') return 'unpdf';
  if (process.env.ALIDOCMIND_ACCESS_KEY_ID && process.env.ALIDOCMIND_ACCESS_KEY_SECRET)
    return 'alidocmind';
  if (process.env.PDF_MINERU_CLOUD_API_KEY) return 'mineru-cloud';
  if (process.env.PDF_MINERU_BASE_URL) return 'mineru';
  if (mimeType.startsWith('audio/') || mimeType.startsWith('video/')) {
    throw new OpenMaicError(
      'MATERIAL_ERROR',
      'Audio/video extraction requires ALIDOCMIND_ACCESS_KEY_ID and ALIDOCMIND_ACCESS_KEY_SECRET.',
    );
  }
  throw new OpenMaicError(
    'MATERIAL_ERROR',
    `No document provider is configured for ${mimeType}. Use --document-provider and set its credentials.`,
  );
}

async function parseUnpdf(buffer: Buffer, name: string): Promise<ParsedPart> {
  const [{ extractImages, extractText, getDocumentProxy }, sharpModule] = await Promise.all([
    import('unpdf'),
    import('sharp'),
  ]);
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  const images: ParsedPart['images'] = [];
  for (let page = 1; page <= pdf.numPages; page += 1) {
    const extracted = await extractImages(pdf, page).catch(() => []);
    for (const image of extracted) {
      try {
        const data = await sharpModule
          .default(Buffer.from(image.data), {
            raw: { width: image.width, height: image.height, channels: image.channels },
          })
          .png()
          .toBuffer();
        images.push({
          id: `raw_img_${images.length + 1}`,
          kind: 'image',
          mimeType: 'image/png',
          data,
          pageNumber: page,
          width: image.width,
          height: image.height,
        });
      } catch {
        // One malformed embedded image must not reject an otherwise readable PDF.
      }
    }
  }
  return { sourceId: nanoid(), name, order: 0, mimeType: 'application/pdf', text, images };
}

function parseMinerUResult(
  raw: Record<string, unknown>,
  name: string,
  mimeType: string,
): ParsedPart {
  const resultMap =
    raw.results && typeof raw.results === 'object'
      ? (raw.results as Record<string, unknown>)
      : undefined;
  const firstResult = resultMap ? Object.values(resultMap)[0] : raw;
  const value = (firstResult && typeof firstResult === 'object' ? firstResult : raw) as Record<
    string,
    unknown
  >;
  const text = String(value.md_content ?? value.markdown ?? value.text ?? '');
  const rawImages =
    value.images && typeof value.images === 'object'
      ? (value.images as Record<string, unknown>)
      : {};
  const images = Object.entries(rawImages).flatMap(([id, encoded], index) => {
    if (typeof encoded !== 'string') return [];
    const match = encoded.match(/^data:([^;]+);base64,(.+)$/);
    const imageMime = match?.[1];
    const imageData = match?.[2];
    return imageMime && imageData
      ? [
          {
            id: id || `raw_img_${index + 1}`,
            kind: 'image' as const,
            mimeType: imageMime,
            data: Buffer.from(imageData, 'base64'),
            pageNumber: 1,
          },
        ]
      : [];
  });
  return { sourceId: nanoid(), name, order: 0, mimeType, text, images };
}

async function parseMinerUSelfHosted(
  buffer: Buffer,
  name: string,
  mimeType: string,
  signal?: AbortSignal,
): Promise<ParsedPart> {
  const baseUrl = process.env.PDF_MINERU_BASE_URL;
  if (!baseUrl)
    throw new OpenMaicError('MATERIAL_ERROR', 'PDF_MINERU_BASE_URL is required for mineru.');
  if (!MINERU_MIMES.has(mimeType))
    throw new OpenMaicError('MATERIAL_ERROR', `MinerU does not support ${mimeType}.`);
  const form = new FormData();
  form.append('files', new Blob([new Uint8Array(buffer)]), name);
  form.append('return_md', 'true');
  form.append('return_images', 'true');
  const response = await createNetworkAdapter()(`${baseUrl.replace(/\/+$/, '')}/file_parse`, {
    method: 'POST',
    body: form,
    signal,
  });
  if (!response.ok)
    throw new OpenMaicError(
      'MATERIAL_ERROR',
      `MinerU error (${response.status}): ${await readResponseText(response)}`,
    );
  return parseMinerUResult(
    await readResponseJson<Record<string, unknown>>(response, 50 * 1024 * 1024),
    name,
    mimeType,
  );
}

async function parseMinerUCloud(
  buffer: Buffer,
  name: string,
  mimeType: string,
  signal?: AbortSignal,
): Promise<ParsedPart> {
  const apiKey = process.env.PDF_MINERU_CLOUD_API_KEY;
  if (!apiKey)
    throw new OpenMaicError(
      'MATERIAL_ERROR',
      'PDF_MINERU_CLOUD_API_KEY is required for mineru-cloud.',
    );
  const root = (process.env.PDF_MINERU_CLOUD_BASE_URL ?? 'https://mineru.net/api/v4').replace(
    /\/+$/,
    '',
  );
  const fetcher = createNetworkAdapter({ timeoutMs: 180_000, maxResponseBytes: 200 * 1024 * 1024 });
  const batchResponse = await fetcher(`${root}/file-urls/batch`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [{ name }],
      enable_formula: true,
      enable_table: true,
      model_version: 'vlm',
    }),
    signal,
    credentialBearing: true,
  });
  const envelope = await readResponseJson<{
    code: number;
    msg?: string;
    data?: { batch_id?: string; file_urls?: string[]; files?: string[] };
  }>(batchResponse);
  if (!batchResponse.ok || envelope.code !== 0 || !envelope.data?.batch_id)
    throw new OpenMaicError(
      'MATERIAL_ERROR',
      `MinerU Cloud batch failed: ${envelope.msg ?? batchResponse.statusText}`,
    );
  const uploadUrl = (envelope.data.file_urls ?? envelope.data.files)?.[0];
  if (!uploadUrl)
    throw new OpenMaicError('MATERIAL_ERROR', 'MinerU Cloud did not return an upload URL.');
  const upload = await fetcher(uploadUrl, {
    method: 'PUT',
    body: new Uint8Array(buffer),
    signal,
    redirect: 'manual',
  });
  if (!upload.ok)
    throw new OpenMaicError('MATERIAL_ERROR', `MinerU Cloud upload failed (${upload.status}).`);
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const poll = await fetcher(`${root}/extract-results/batch/${envelope.data.batch_id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
      credentialBearing: true,
    });
    const status = await readResponseJson<{
      code: number;
      data?: {
        extract_result?:
          | Array<{ state?: string; full_zip_url?: string; err_msg?: string }>
          | { state?: string; full_zip_url?: string; err_msg?: string };
      };
    }>(poll);
    const rows = Array.isArray(status.data?.extract_result)
      ? status.data.extract_result
      : status.data?.extract_result
        ? [status.data.extract_result]
        : [];
    const row = rows[0];
    if (row?.state === 'failed')
      throw new OpenMaicError(
        'MATERIAL_ERROR',
        `MinerU Cloud parsing failed: ${row.err_msg ?? 'unknown error'}`,
      );
    if (row?.state === 'done' && row.full_zip_url) {
      const zipResponse = await fetcher(row.full_zip_url, { signal, redirect: 'manual' });
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(await readResponseBuffer(zipResponse, 200 * 1024 * 1024));
      const files = Object.keys(zip.files).filter((path) => !zip.files[path]?.dir);
      const markdownPath = files.find((path) => /(^|\/)full\.md$/i.test(path));
      if (!markdownPath)
        throw new OpenMaicError('MATERIAL_ERROR', 'MinerU Cloud result has no full.md.');
      const text = await zip.file(markdownPath)!.async('string');
      const images: ParsedPart['images'] = [];
      for (const path of files
        .filter((entry) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(entry))
        .slice(0, 200)) {
        const data = await zip.file(path)!.async('nodebuffer');
        const extension = extname(path).toLowerCase();
        const imageMime =
          extension === '.jpg' || extension === '.jpeg'
            ? 'image/jpeg'
            : `image/${extension.slice(1)}`;
        images.push({
          id: basename(path),
          kind: 'image',
          mimeType: imageMime,
          data,
          pageNumber: 1,
        });
      }
      return { sourceId: nanoid(), name, order: 0, mimeType, text, images };
    }
    await new Promise((resolve) => setTimeout(resolve, 2_500));
  }
  throw new OpenMaicError('MATERIAL_ERROR', 'MinerU Cloud parsing timed out.');
}

async function parseFile(
  path: string,
  order: number,
  providerId: string | undefined,
  signal?: AbortSignal,
): Promise<ParsedPart> {
  const info = await stat(path);
  if (!info.isFile()) throw new OpenMaicError('MATERIAL_ERROR', `Material is not a file: ${path}`);
  const mimeType = MIME_BY_EXTENSION[extname(path).toLowerCase()];
  if (!mimeType) throw new OpenMaicError('MATERIAL_ERROR', `Unsupported material format: ${path}`);
  const buffer = await readFile(path);
  throwIfAborted(signal);
  const name = basename(path);
  const provider = providerFor(mimeType, providerId);
  let part: ParsedPart;
  if (provider === 'plain-text')
    part = { sourceId: nanoid(), name, order, mimeType, text: decodeText(buffer), images: [] };
  else if (provider === 'unpdf') part = await parseUnpdf(buffer, name);
  else if (provider === 'mineru')
    part = await parseMinerUSelfHosted(buffer, name, mimeType, signal);
  else if (provider === 'mineru-cloud')
    part = await parseMinerUCloud(buffer, name, mimeType, signal);
  else if (provider === 'alidocmind') {
    const parsed = await (
      await import('./alidocmind.js')
    ).parseAliDocMind(buffer, name, mimeType, signal);
    part = { ...parsed, sourceId: nanoid(), order: 0 };
  } else throw new OpenMaicError('MATERIAL_ERROR', `Unknown document provider: ${provider}`);
  return { ...part, order, mimeType, name };
}

function allocate(lengths: number[], budget: number): number[] {
  if (!lengths.length) return [];
  const minimum = Math.min(1_500, Math.floor((budget * 0.4) / lengths.length));
  const values = lengths.map((length) => Math.min(length, minimum));
  let remaining = budget - values.reduce((sum, value) => sum + value, 0);
  while (remaining > 0) {
    const outstanding = lengths
      .map((length, index) => Math.max(0, length - (values[index] ?? 0)))
      .reduce((sum, value) => sum + value, 0);
    if (!outstanding) break;
    let changed = false;
    lengths.forEach((length, index) => {
      if (remaining <= 0) return;
      const current = values[index] ?? 0;
      const need = length - current;
      if (need <= 0) return;
      const amount = Math.min(
        need,
        Math.max(1, Math.floor((remaining * need) / outstanding)),
        remaining,
      );
      values[index] = current + amount;
      remaining -= amount;
      changed = true;
    });
    if (!changed) break;
  }
  return values;
}

function bundleParts(parts: ParsedPart[]): MaterialBundle {
  const sorted = [...parts].sort((left, right) => left.order - right.order);
  const headers = sorted.map(
    (part, index) =>
      `## Source Document ${index + 1}: ${part.name}\n- Order: ${part.order}\n- MIME type: ${part.mimeType}\n\n`,
  );
  const framing =
    headers.reduce((sum, header) => sum + header.length, 0) + Math.max(0, sorted.length - 1) * 7;
  const budgets = allocate(
    sorted.map((part) => part.text.length),
    Math.max(0, MAX_TEXT_CHARS - framing),
  );
  const text = sorted
    .map((part, index) => `${headers[index] ?? ''}${part.text.slice(0, budgets[index] ?? 0)}`)
    .join('\n\n---\n\n');
  let imageIndex = 0;
  const images = sorted.flatMap((part) =>
    part.images.map((image) => ({
      ...image,
      id: `img_${++imageIndex}`,
      sourceDocumentId: part.sourceId,
      sourceDocumentName: part.name,
      sourceDocumentOrder: part.order,
      visionPriority: 0,
    })),
  );
  images
    .sort(
      (left, right) =>
        left.sourceDocumentOrder - right.sourceDocumentOrder || left.pageNumber - right.pageNumber,
    )
    .slice(0, MAX_VISION_IMAGES)
    .forEach((image, index) => {
      image.visionPriority = MAX_VISION_IMAGES - index;
    });
  return {
    text,
    images,
    totalRawTextLength: sorted.reduce((sum, part) => sum + part.text.length, 0),
    totalImageCount: images.length,
    visionImageCount: Math.min(images.length, MAX_VISION_IMAGES),
  };
}

export async function extractMaterials(input: ExtractMaterialsInput): Promise<MaterialBundle> {
  if (input.paths.length > MAX_DOCUMENT_BUNDLE_FILES) {
    throw new OpenMaicError(
      'MATERIAL_ERROR',
      `At most ${MAX_DOCUMENT_BUNDLE_FILES} material files are allowed.`,
    );
  }
  const stats = await Promise.all(input.paths.map((path) => stat(path)));
  const total = stats.reduce((sum, value) => sum + value.size, 0);
  if (total > MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES) {
    throw new OpenMaicError('MATERIAL_ERROR', 'Material files exceed the 150 MB total limit.');
  }
  for (const path of input.paths) {
    const mimeType = MIME_BY_EXTENSION[extname(path).toLowerCase()];
    if (!mimeType)
      throw new OpenMaicError('MATERIAL_ERROR', `Unsupported material format: ${path}`);
    providerFor(mimeType, input.providerId);
  }
  const parts: ParsedPart[] = [];
  for (const [index, path] of input.paths.entries()) {
    throwIfAborted(input.signal);
    input.onProgress?.({
      type: 'extract',
      current: index + 1,
      total: input.paths.length,
      file: path,
    });
    parts.push(await parseFile(path, index + 1, input.providerId, input.signal));
  }
  return bundleParts(parts);
}

export function normalizeMaterialMimeType(fileName: string): string | undefined {
  return MIME_BY_EXTENSION[extname(fileName).toLowerCase()];
}
