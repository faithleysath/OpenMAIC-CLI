#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import {
  CLASSROOM_EXTENSION,
  OUTLINE_EXTENSION,
  OpenMaicError,
  createOpenMaicGenerator,
  diagnoseConfiguration,
  isAbortError,
  readOutlineInput,
  writeMaicArchive,
  writeOutlineBundle,
  type GenerationWarning,
  type ProgressEvent,
} from '@faithleysath/openmaic-generator';
import { loadConfig, loadLocalEnvironment, parseThinking, resolveCliModel } from './config.js';

const VERSION = '0.1.0';

const HELP = `OpenMAIC local BYOK generator

Usage:
  openmaic doctor [--probe]
  openmaic outline <requirement> --output <file.maic-outline.zip> [--material <path> ...]
  openmaic scene --outline <file.maic-outline.zip> [--scene <id|number|all>] --output <file.maic.zip>
  openmaic generate <requirement> --output <file.maic.zip> [--material <path> ...]

Options:
  --config <path>             Configuration file (default: .openmaicrc.json)
  --model <provider:model>    LLM model (or DEFAULT_MODEL)
  --material <path>           Repeatable course material
  --document-provider <id>    unpdf, mineru, mineru-cloud, or alidocmind
  --web-search                Enable web search
  --search-provider <id>      tavily, bocha, brave, baidu, minimax, doubao, searxng
  --strict-search             Fail if web search fails
  --image [--image-provider]  Generate requested images
  --video [--video-provider]  Generate requested videos
  --tts [--tts-provider]      Generate speech audio
  --strict-media              Fail if any optional media generation fails
  --interactive               Prefer interactive-first outlines
  --thinking <mode|effort|n>  Thinking mode, effort, or token budget
  --output <path>             Required ZIP output
  --force                     Replace an existing output atomically
  --quiet                     Suppress progress on stderr
  --help                      Show help
  --version                   Show version`;

const options = {
  config: { type: 'string' },
  model: { type: 'string' },
  material: { type: 'string', multiple: true },
  'document-provider': { type: 'string' },
  'web-search': { type: 'boolean' },
  'search-provider': { type: 'string' },
  'strict-search': { type: 'boolean' },
  image: { type: 'boolean' },
  video: { type: 'boolean' },
  tts: { type: 'boolean' },
  'image-provider': { type: 'string' },
  'video-provider': { type: 'string' },
  'tts-provider': { type: 'string' },
  output: { type: 'string' },
  outline: { type: 'string' },
  scene: { type: 'string' },
  interactive: { type: 'boolean' },
  thinking: { type: 'string' },
  'strict-media': { type: 'boolean' },
  force: { type: 'boolean' },
  quiet: { type: 'boolean' },
  probe: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

function stderr(message: string): void {
  process.stderr.write(`${message}\n`);
}
function result(output: string | null, warnings: GenerationWarning[] = []): void {
  process.stdout.write(`${JSON.stringify({ success: true, output, warnings })}\n`);
}

function progress(event: ProgressEvent): void {
  switch (event.type) {
    case 'preflight':
      stderr(event.message);
      break;
    case 'extract':
      stderr(`[material ${event.current}/${event.total}] ${event.file}`);
      break;
    case 'search':
      stderr(`[search:${event.providerId}] ${event.query}`);
      break;
    case 'outline':
      stderr(`[outline] ${event.phase}`);
      break;
    case 'scene':
      stderr(`[scene ${event.current}/${event.total}] ${event.phase}: ${event.title}`);
      break;
    case 'asset':
      stderr(`[asset] ${event.phase}: ${event.ref}`);
      break;
  }
}

function requireOutput(path: string | undefined, extension: string): string {
  if (!path)
    throw new OpenMaicError(
      'INVALID_ARGUMENT',
      `--output is required and must end with ${extension}.`,
    );
  if (!path.endsWith(extension))
    throw new OpenMaicError('INVALID_ARGUMENT', `Output must end with ${extension}: ${path}`);
  return resolve(path);
}

function requireRequirement(positionals: string[]): string {
  const requirement = positionals.join(' ').trim();
  if (!requirement)
    throw new OpenMaicError('INVALID_ARGUMENT', 'A course requirement is required.');
  return requirement;
}

function exitCode(error: unknown): number {
  if (isAbortError(error)) return 130;
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('ERR_PARSE_ARGS')
  ) {
    return 2;
  }
  if (!(error instanceof OpenMaicError)) return 5;
  switch (error.code) {
    case 'INVALID_ARGUMENT':
    case 'CONFIG_ERROR':
      return 2;
    case 'MATERIAL_ERROR':
      return 3;
    case 'PROVIDER_ERROR':
      return 4;
    case 'GENERATION_ERROR':
      return 5;
    case 'ARCHIVE_ERROR':
      return 6;
  }
}

async function main(): Promise<void> {
  await loadLocalEnvironment();
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options,
    allowPositionals: true,
    strict: true,
  });
  if (parsed.values.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (parsed.values.help || parsed.positionals.length === 0) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const command = parsed.positionals[0]!;
  const positionals = parsed.positionals.slice(1);
  if (!['doctor', 'outline', 'scene', 'generate'].includes(command))
    throw new OpenMaicError('INVALID_ARGUMENT', `Unknown command: ${command}`);
  const config = await loadConfig(parsed.values.config);
  const thinking = parseThinking(parsed.values.thinking);
  const model = resolveCliModel({ model: parsed.values.model, thinking }, config);
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const onProgress = parsed.values.quiet ? undefined : progress;
  const generator = createOpenMaicGenerator({
    model,
    documentProviderId: parsed.values['document-provider'] ?? config.documentProvider,
    searchProviderId: parsed.values['search-provider'] ?? config.searchProvider,
    imageProviderId: parsed.values['image-provider'] ?? config.imageProvider,
    videoProviderId: parsed.values['video-provider'] ?? config.videoProvider,
    ttsProviderId: parsed.values['tts-provider'] ?? config.ttsProvider,
  });

  if (command === 'doctor') {
    const checks = await diagnoseConfiguration({ model, probe: parsed.values.probe });
    if (!parsed.values.quiet)
      for (const check of checks)
        stderr(`${check.ok ? 'OK' : 'FAIL'} ${check.id}: ${check.message}`);
    const failures = checks
      .filter((check) => !check.ok)
      .map((check) => ({ code: `DOCTOR_${check.id.toUpperCase()}`, message: check.message }));
    if (failures.length)
      throw new OpenMaicError(
        'PROVIDER_ERROR',
        failures.map((failure) => failure.message).join('; '),
      );
    result(null, []);
    return;
  }

  if (command === 'outline') {
    const output = requireOutput(parsed.values.output ?? config.output, OUTLINE_EXTENSION);
    const requirement = requireRequirement(positionals);
    const materials = parsed.values.material?.length
      ? await generator.extractMaterials({
          paths: parsed.values.material.map((path) => resolve(path)),
          signal: controller.signal,
          onProgress,
        })
      : undefined;
    const generated = await generator.generateOutline({
      requirement,
      materials,
      webSearch: parsed.values['web-search'],
      strictSearch: parsed.values['strict-search'],
      interactiveMode: parsed.values.interactive,
      imageGenerationEnabled: parsed.values.image,
      videoGenerationEnabled: parsed.values.video,
      signal: controller.signal,
      onProgress,
    });
    await writeOutlineBundle(generated, output, {
      force: parsed.values.force,
      signal: controller.signal,
    });
    result(output, generated.document.warnings);
    return;
  }

  if (command === 'scene') {
    const inputPath = parsed.values.outline;
    if (!inputPath || !inputPath.endsWith(OUTLINE_EXTENSION))
      throw new OpenMaicError(
        'INVALID_ARGUMENT',
        `--outline must reference a ${OUTLINE_EXTENSION} file.`,
      );
    const output = requireOutput(parsed.values.output ?? config.output, CLASSROOM_EXTENSION);
    const restored = await readOutlineInput(resolve(inputPath));
    const { materials: _manifest, ...document } = restored.document;
    const generated = await generator.generateScene({
      outline: { document, materialBundle: restored.materials },
      scene: parsed.values.scene ?? 'all',
      image: parsed.values.image,
      video: parsed.values.video,
      tts: parsed.values.tts,
      strictMedia: parsed.values['strict-media'],
      signal: controller.signal,
      onProgress,
    });
    await writeMaicArchive(generated, output, {
      force: parsed.values.force,
      signal: controller.signal,
    });
    result(output, generated.document.warnings);
    return;
  }

  const output = requireOutput(parsed.values.output ?? config.output, CLASSROOM_EXTENSION);
  const generated = await generator.generateCourse({
    requirement: requireRequirement(positionals),
    materialPaths: parsed.values.material?.map((path) => resolve(path)),
    webSearch: parsed.values['web-search'],
    strictSearch: parsed.values['strict-search'],
    interactiveMode: parsed.values.interactive,
    image: parsed.values.image,
    video: parsed.values.video,
    tts: parsed.values.tts,
    strictMedia: parsed.values['strict-media'],
    signal: controller.signal,
    onProgress,
  });
  await writeMaicArchive(generated, output, {
    force: parsed.values.force,
    signal: controller.signal,
  });
  result(output, generated.document.warnings);
}

main().catch((error: unknown) => {
  stderr(error instanceof Error ? error.message : String(error));
  process.exitCode = exitCode(error);
});
