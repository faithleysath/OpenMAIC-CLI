import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '../..');
const sourceRoot = join(repoRoot, 'lib/prompts');
const destinationRoot = join(packageRoot, 'dist/prompts');

const templates = [
  'requirements-to-outlines',
  'interactive-outlines',
  'web-search-query-rewrite',
  'slide-content',
  'quiz-content',
  'slide-actions',
  'quiz-actions',
  'interactive-actions',
  'simulation-content',
  'diagram-content',
  'code-content',
  'game-content',
  'visualization3d-content',
];

const snippets = [
  'json-output-rules',
  'element-types',
  'action-types',
  'image-instructions',
  'video-instructions',
  'media-safety-guidelines',
  'slide-image-instructions',
  'slide-generated-image-instructions',
  'slide-video-instructions',
  'speech-guidelines',
  'whiteboard-reference',
];

await rm(destinationRoot, { recursive: true, force: true });
await mkdir(join(destinationRoot, 'templates'), { recursive: true });
await mkdir(join(destinationRoot, 'snippets'), { recursive: true });

for (const template of templates) {
  await cp(join(sourceRoot, 'templates', template), join(destinationRoot, 'templates', template), {
    recursive: true,
  });
}

for (const snippet of snippets) {
  await cp(
    join(sourceRoot, 'snippets', `${snippet}.md`),
    join(destinationRoot, 'snippets', `${snippet}.md`),
  );
}

const allowedSnippets = new Set(snippets);
for (const template of templates) {
  for (const file of ['system.md', 'user.md']) {
    const path = join(destinationRoot, 'templates', template, file);
    let content;
    try {
      content = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    for (const match of content.matchAll(/\{\{snippet:([\w-]+)\}\}/g)) {
      if (!allowedSnippets.has(match[1])) {
        throw new Error(`Prompt ${template}/${file} references unlisted snippet ${match[1]}`);
      }
    }
  }
}
