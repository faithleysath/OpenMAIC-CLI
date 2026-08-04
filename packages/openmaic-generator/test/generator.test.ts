import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMaicArchive,
  buildOutlineBundle,
  createOpenMaicGenerator,
  readOutlineInput,
  writeOutlineBundle,
  type LLMCaller,
  type PromptRepository,
  type SceneOutline,
} from '../src/index.js';

const temporaryPaths: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

class QueueLLM implements LLMCaller {
  constructor(private readonly responses: string[]) {}
  async generate(): Promise<string> {
    const response = this.responses.shift();
    if (response === undefined) throw new Error('Unexpected LLM call');
    return response;
  }
}

const prompts: PromptRepository = {
  async build(id, variables) {
    return { system: id, user: JSON.stringify(variables) };
  },
};

describe('generator contracts', () => {
  it('constrains generated outlines and keeps a replayable material snapshot', async () => {
    const llm = new QueueLLM([
      JSON.stringify({
        languageDirective: 'Use Chinese.',
        courseTitle: 'Newton',
        outlines: [
          { type: 'slide', title: 'Force', description: 'Explain force.', keyPoints: ['F=ma'] },
          { type: 'pbl', title: 'Project', description: 'Unsupported.', keyPoints: [] },
        ],
      }),
    ]);
    const generator = createOpenMaicGenerator({ llm, prompts });
    const result = await generator.generateOutline({
      requirement: 'Teach Newton second law',
      materials: {
        text: 'Reference text',
        images: [
          {
            id: 'img_1',
            mimeType: 'image/png',
            data: Buffer.from('image'),
            pageNumber: 1,
            visionPriority: 1,
          },
        ],
        totalRawTextLength: 14,
        totalImageCount: 1,
        visionImageCount: 1,
      },
    });
    expect(result.document.outlines.map((outline) => outline.type)).toEqual(['slide', 'pbl']);
    expect(result.document.outlines[0]?.id).toBeTruthy();

    const directory = await mkdtemp(join(tmpdir(), 'openmaic-outline-'));
    temporaryPaths.push(directory);
    const path = join(directory, 'lesson.maic-outline.zip');
    await writeOutlineBundle(result, path);
    const restored = await readOutlineInput(path);
    expect(restored.document.materials?.entries[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(restored.materials?.text).toBe('Reference text');
    expect(restored.materials?.images[0]?.data.toString()).toBe('image');
  });

  it('builds slide, quiz, interactive scenes and skips PBL', async () => {
    const outlines: SceneOutline[] = [
      {
        id: 's1',
        type: 'slide',
        title: 'Slide',
        description: 'Slide speech',
        keyPoints: ['A'],
        order: 1,
        suggestedImageIds: ['img_1'],
      },
      {
        id: 'q1',
        type: 'quiz',
        title: 'Quiz',
        description: 'Quiz speech',
        keyPoints: ['B'],
        order: 2,
      },
      {
        id: 'i1',
        type: 'interactive',
        title: 'Widget',
        description: 'Widget speech',
        keyPoints: ['C'],
        order: 3,
        widgetType: 'simulation',
        widgetOutline: { concept: 'motion' },
      },
      { id: 'p1', type: 'pbl', title: 'PBL', description: 'skip', keyPoints: [], order: 4 },
    ];
    const llm = new QueueLLM([
      JSON.stringify({
        elements: [{ type: 'image', src: 'img_1', left: 0, top: 0, width: 400, height: 300 }],
      }),
      JSON.stringify([{ type: 'text', content: 'Slide narration' }]),
      JSON.stringify([{ type: 'single', question: 'Q?', options: ['A', 'B'], correctAnswer: 'A' }]),
      JSON.stringify([{ type: 'text', content: 'Quiz narration' }]),
      '<html><head></head><body><button id="run">Run</button></body></html>',
      JSON.stringify([
        { type: 'action', name: 'widget_highlight', params: { target: '#run' } },
        { type: 'text', content: 'Widget narration' },
      ]),
    ]);
    const generator = createOpenMaicGenerator({ llm, prompts });
    const result = await generator.generateScenes({
      outline: {
        document: {
          kind: 'openmaic-outline',
          formatVersion: 1,
          generatorVersion: '0.1.0',
          requirement: 'Course',
          languageDirective: 'Use English.',
          outlines,
          warnings: [],
        },
        materialBundle: {
          text: '',
          images: [
            {
              id: 'img_1',
              mimeType: 'image/png',
              data: Buffer.from('source-image'),
              pageNumber: 1,
              width: 800,
              height: 600,
            },
          ],
          totalRawTextLength: 0,
          totalImageCount: 1,
          visionImageCount: 1,
        },
      },
    });
    expect(result.document.scenes.map((scene) => scene.type)).toEqual([
      'slide',
      'quiz',
      'interactive',
    ]);
    expect(result.document.warnings).toContainEqual(
      expect.objectContaining({ code: 'PBL_UNSUPPORTED', sceneId: 'p1' }),
    );
    expect(result.assetBlobs).toContainEqual(
      expect.objectContaining({ ref: expect.stringMatching(/^gen_img_source_/), type: 'image' }),
    );

    const archive = await buildMaicArchive(result);
    const zip = await JSZip.loadAsync(archive);
    expect(zip.file('manifest.json')).not.toBeNull();
    expect(zip.file('generation.json')).not.toBeNull();
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.scenes).toHaveLength(3);
    expect(Object.keys(manifest.mediaIndex)).toContainEqual(
      expect.stringMatching(/^media\/gen_img_source_/),
    );
  });

  it('always emits outline.json even without materials', async () => {
    const buffer = await buildOutlineBundle({
      document: {
        kind: 'openmaic-outline',
        formatVersion: 1,
        generatorVersion: '0.1.0',
        requirement: 'R',
        languageDirective: 'L',
        outlines: [],
        warnings: [],
      },
    });
    const zip = await JSZip.loadAsync(buffer);
    expect(zip.file('outline.json')).not.toBeNull();
  });
});
