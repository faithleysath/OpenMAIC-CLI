import { Readable } from 'node:stream';
import Client from '@alicloud/docmind-api20220711/dist/client.js';
import * as Docmind from '@alicloud/docmind-api20220711';
import { Config } from '@alicloud/openapi-client';
import { RuntimeOptions } from '@alicloud/tea-util';
import { OpenMaicError, throwIfAborted } from '../errors.js';

type AliDocMindClient = {
  submitDocParserJobAdvance(
    request: unknown,
    runtime: RuntimeOptions,
  ): Promise<{ body?: { data?: { id?: string } } }>;
  queryDocParserStatus(
    request: unknown,
  ): Promise<{ body?: { data?: { status?: string }; message?: string } }>;
  getDocParserResult(request: unknown): Promise<{ body?: { data?: unknown } }>;
};

type AliDocMindClientConstructor = new (config: Config) => AliDocMindClient;

export async function parseAliDocMind(
  buffer: Buffer,
  name: string,
  mimeType: string,
  signal?: AbortSignal,
): Promise<{ name: string; mimeType: string; text: string; images: [] }> {
  throwIfAborted(signal);
  const accessKeyId = process.env.ALIDOCMIND_ACCESS_KEY_ID;
  const accessKeySecret = process.env.ALIDOCMIND_ACCESS_KEY_SECRET;
  if (!accessKeyId || !accessKeySecret) {
    throw new OpenMaicError(
      'MATERIAL_ERROR',
      'ALIDOCMIND_ACCESS_KEY_ID and ALIDOCMIND_ACCESS_KEY_SECRET are required.',
    );
  }
  const endpoint = (
    process.env.ALIDOCMIND_BASE_URL ?? 'docmind-api.cn-hangzhou.aliyuncs.com'
  ).replace(/^https?:\/\//, '');
  const ClientConstructor = (Client as unknown as { default: AliDocMindClientConstructor }).default;
  const client = new ClientConstructor(new Config({ accessKeyId, accessKeySecret, endpoint }));
  const extension = name.split('.').pop()?.toLowerCase();
  if (!extension) throw new OpenMaicError('MATERIAL_ERROR', `Cannot infer extension for ${name}.`);
  const isMedia = mimeType.startsWith('audio/') || mimeType.startsWith('video/');
  const request = new Docmind.SubmitDocParserJobAdvanceRequest({
    fileName: name,
    fileNameExtension: extension,
    fileUrlObject: Readable.from(buffer),
    llmEnhancement: !isMedia,
    enhancementMode: !isMedia ? 'VLM' : undefined,
    option: isMedia ? 'advance' : undefined,
    outputHtmlTable: !isMedia,
  });
  const submit = await client.submitDocParserJobAdvance(
    request,
    new RuntimeOptions({ connectTimeout: 30_000, readTimeout: 300_000 }),
  );
  const jobId = submit.body?.data?.id;
  if (!jobId) throw new OpenMaicError('MATERIAL_ERROR', 'AliDocMind submit returned no job id.');
  const deadline = Date.now() + 15 * 60_000;
  let completed = false;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const status = await client.queryDocParserStatus(
      new Docmind.QueryDocParserStatusRequest({ id: jobId }),
    );
    const state = String(status.body?.data?.status ?? '').toLowerCase();
    if (state === 'fail' || state === 'failed') {
      throw new OpenMaicError(
        'MATERIAL_ERROR',
        `AliDocMind job failed: ${status.body?.message ?? 'unknown'}`,
      );
    }
    if (state === 'success') {
      completed = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  if (!completed) throw new OpenMaicError('MATERIAL_ERROR', 'AliDocMind parsing timed out.');
  const result = await client.getDocParserResult(
    new Docmind.GetDocParserResultRequest({ id: jobId, layoutNum: 0, layoutStepSize: 1000 }),
  );
  const data = result.body?.data as Record<string, unknown> | undefined;
  const layouts = Array.isArray(data?.layouts)
    ? (data.layouts as Array<Record<string, unknown>>)
    : [];
  const segments = Array.isArray(data?.segments)
    ? (data.segments as Array<Record<string, unknown>>)
    : [];
  const text = isMedia
    ? segments
        .map((segment) => String(segment.text ?? segment.content ?? ''))
        .filter(Boolean)
        .join('\n')
    : layouts
        .map((layout) => String(layout.text ?? layout.markdown ?? layout.content ?? ''))
        .filter(Boolean)
        .join('\n\n');
  return { name, mimeType, text, images: [] };
}
