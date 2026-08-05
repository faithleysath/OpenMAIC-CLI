import katex from 'katex';
import { nanoid } from 'nanoid';
import {
  normalizeElement,
  type Action,
  type PPTElement,
  type QuizQuestion,
  type SlideBackground,
  type Stage,
} from '@openmaic/dsl';
import type { LLMCaller } from '../ai.js';
import type {
  CliAgent,
  CliScene,
  GeneratedSceneContent,
  MaterialBundle,
  MaterialImage,
  SceneOutline,
  WidgetType,
} from '../contracts/types.js';
import type { PromptRepository } from '../prompts.js';
import { parseActions } from './actions.js';
import {
  agentsForPrompt,
  courseContext,
  imageDescription,
  languageText,
  teacherForPrompt,
  type SceneGenerationContext,
} from './formatters.js';
import { parseJsonResponse } from './json.js';

const WIDGET_ACTIONS = [
  'widget_highlight',
  'widget_setState',
  'widget_annotation',
  'widget_reveal',
] as const;

function stripNulls(value: unknown): unknown {
  if (Array.isArray(value) || !value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => field !== null)
      .map(([key, field]) => [key, stripNulls(field)]),
  );
}

function dataUrl(image: MaterialImage): string {
  return `data:${image.mimeType};base64,${image.data.toString('base64')}`;
}

function normalizeSlideElements(raw: unknown[], images: readonly MaterialImage[]): PPTElement[] {
  const mapping = new Map(images.map((image) => [image.id, image]));
  return raw.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const element = { ...(stripNulls(candidate) as Record<string, unknown>) };
    const type = element.type;
    if (typeof type !== 'string') return [];
    if (type === 'image' && typeof element.src === 'string') {
      const source = mapping.get(element.src);
      if (source) {
        element.src = dataUrl(source);
        if (source.width && source.height && typeof element.width === 'number') {
          element.height = Math.min(
            462,
            Math.round(element.width / (source.width / source.height)),
          );
        }
      } else if (!/^gen_img_[\w-]+$/.test(element.src) && !/^(?:https?:|data:)/.test(element.src)) {
        return [];
      }
    }
    if (type === 'latex' && typeof element.latex === 'string') {
      element.html = katex.renderToString(element.latex, {
        throwOnError: false,
        displayMode: true,
        output: 'html',
      });
      element.fixedRatio = true;
    }
    try {
      return [
        {
          ...normalizeElement(element),
          id: `${type}_${nanoid(8)}`,
          rotate: typeof element.rotate === 'number' ? element.rotate : 0,
        } as PPTElement,
      ];
    } catch {
      return [];
    }
  });
}

function normalizeQuizQuestions(raw: unknown[]): QuizQuestion[] {
  return raw.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const question = candidate as Record<string, unknown>;
    const type =
      question.type === 'multiple' || question.type === 'short_answer' ? question.type : 'single';
    const options =
      type === 'short_answer' || !Array.isArray(question.options)
        ? undefined
        : question.options.map((option, index) => {
            const fallback = String.fromCharCode(65 + index);
            return typeof option === 'string'
              ? { value: fallback, label: option }
              : {
                  value:
                    typeof (option as Record<string, unknown>)?.value === 'string'
                      ? String((option as Record<string, unknown>).value)
                      : fallback,
                  label:
                    typeof (option as Record<string, unknown>)?.label === 'string'
                      ? String((option as Record<string, unknown>).label)
                      : fallback,
                };
          });
    const rawAnswer = question.answer ?? question.correctAnswer ?? question.correct_answer;
    const answer =
      type === 'short_answer' || rawAnswer == null
        ? undefined
        : Array.isArray(rawAnswer)
          ? rawAnswer.map(String)
          : [String(rawAnswer)];
    return [
      {
        ...question,
        id: typeof question.id === 'string' ? question.id : `q_${nanoid(8)}`,
        type,
        question: typeof question.question === 'string' ? question.question : '',
        options,
        answer,
        hasAnswer: type !== 'short_answer',
      } as QuizQuestion,
    ];
  });
}

function extractHtml(response: string): string | null {
  for (const expression of [
    /```html\s*([\s\S]*?)```/i,
    /(<html[\s\S]*?<\/html>)/i,
    /<!DOCTYPE[\s\S]*?<\/html>/i,
  ]) {
    const match = response.match(expression);
    if (match) return (match[1] ?? match[0]).trim();
  }
  return response.trim().startsWith('<') ? response.trim() : null;
}

function postProcessHtml(html: string): string {
  let result = html.replace(/\$\$([^$]+)\$\$/g, '\\[$1\\]').replace(/\$([^$\n]+?)\$/g, '\\($1\\)');
  if (!result.toLowerCase().includes('katex')) {
    const resources =
      '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css"><script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script><script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script>';
    result = result.includes('</head>')
      ? result.replace('</head>', `${resources}</head>`)
      : `${resources}${result}`;
  }
  return result;
}

function widgetVariables(
  outline: SceneOutline,
  directive: string,
): { promptId: string; variables: Record<string, unknown> } {
  const widget = outline.widgetOutline ?? { concept: outline.title };
  const type: WidgetType =
    outline.widgetType === 'procedural-skill' ? 'diagram' : (outline.widgetType ?? 'simulation');
  const common = {
    title: outline.title,
    description: outline.description,
    keyPoints: outline.keyPoints.join('\n'),
    languageDirective: directive,
  };
  switch (type) {
    case 'diagram':
      return {
        promptId: 'diagram-content',
        variables: {
          ...common,
          diagramType: widget.diagramType ?? 'flowchart',
          nodeCount: widget.nodeCount ?? widget.nodes?.length ?? 0,
          prescribedNodes: widget.nodes ?? [],
          hasNodeCount: Boolean(widget.nodeCount),
          hasPrescribedNodes: Boolean(widget.nodes?.length),
        },
      };
    case 'code':
      return {
        promptId: 'code-content',
        variables: {
          ...common,
          programmingLanguage: widget.language ?? 'python',
          starterCode: '',
          testCases: '',
          hints: '',
        },
      };
    case 'game':
      return {
        promptId: 'game-content',
        variables: {
          ...common,
          gameType: widget.gameType ?? 'quiz',
          scoring: { correctPoints: 10, speedBonus: 5 },
        },
      };
    case 'visualization3d':
      return {
        promptId: 'visualization3d-content',
        variables: {
          ...common,
          visualizationType: widget.visualizationType ?? 'custom',
          objects: widget.objects ?? [],
          interactions: widget.interactions ?? [],
        },
      };
    default:
      return {
        promptId: 'simulation-content',
        variables: {
          ...common,
          conceptName: widget.concept ?? outline.title,
          conceptOverview: outline.description,
          variables: widget.keyVariables?.join(', ') ?? '',
          designIdea: outline.interactiveConfig?.designIdea ?? '',
        },
      };
  }
}

export async function generateSceneContent(
  outline: SceneOutline,
  materials: MaterialBundle | undefined,
  llm: LLMCaller,
  prompts: PromptRepository,
  agents: readonly CliAgent[],
  directive: string,
  signal?: AbortSignal,
): Promise<GeneratedSceneContent | null> {
  const sceneDirective = languageText(directive, outline.languageNote);
  if (outline.type === 'slide') {
    const ids = new Set(outline.suggestedImageIds ?? []);
    const images = (materials?.images ?? [])
      .filter((image) => ids.size === 0 || ids.has(image.id))
      .slice(0, 20);
    const attachedImages = llm.supportsVision === false ? [] : images;
    const media = outline.mediaGenerations ?? [];
    const assigned =
      [
        ...images.map((image) => imageDescription(image, true)),
        ...media.map((entry) => `- ${entry.elementId}: "${entry.prompt}" (${entry.type})`),
      ].join('\n') || 'No media is available. Do not insert image or video elements.';
    const prompt = await prompts.build('slide-content', {
      title: outline.title,
      description: outline.description,
      keyPoints: outline.keyPoints.map((point, index) => `${index + 1}. ${point}`).join('\n'),
      elements: '(generate from the key points)',
      assignedImages: assigned,
      canvas_width: 1000,
      canvas_height: 562.5,
      teacherContext: teacherForPrompt(agents),
      languageDirective: sceneDirective,
      imageElementEnabled: images.length > 0 || media.some((entry) => entry.type === 'image'),
      generatedImageEnabled: media.some((entry) => entry.type === 'image'),
      generatedVideoEnabled: media.some((entry) => entry.type === 'video'),
      mediaElementEnabled: images.length > 0 || media.length > 0,
    });
    const response = await llm.generate({
      system: prompt.system,
      user: prompt.user,
      images: attachedImages.map((image) => ({
        id: image.id,
        data: image.data,
        mimeType: image.mimeType,
      })),
      signal,
      maxOutputTokens: llm.outputWindow,
    });
    const parsed = parseJsonResponse<{
      elements?: unknown[];
      background?: SlideBackground;
      remark?: string;
    }>(response);
    if (!parsed?.elements || !Array.isArray(parsed.elements)) return null;
    return {
      elements: normalizeSlideElements(parsed.elements, images),
      background: parsed.background,
      remark: parsed.remark ?? outline.description,
    };
  }
  if (outline.type === 'quiz') {
    const config = outline.quizConfig ?? {
      questionCount: 3,
      difficulty: 'medium',
      questionTypes: ['single'],
    };
    const prompt = await prompts.build('quiz-content', {
      title: outline.title,
      description: outline.description,
      keyPoints: outline.keyPoints.join('\n'),
      questionCount: config.questionCount,
      difficulty: config.difficulty,
      questionTypes: config.questionTypes.join(', '),
      languageDirective: sceneDirective,
    });
    const response = await llm.generate({
      system: prompt.system,
      user: prompt.user,
      signal,
      maxOutputTokens: llm.outputWindow,
    });
    const parsed = parseJsonResponse<unknown[]>(response);
    return Array.isArray(parsed) ? { questions: normalizeQuizQuestions(parsed) } : null;
  }
  if (outline.type === 'interactive') {
    const { promptId, variables } = widgetVariables(outline, sceneDirective);
    const prompt = await prompts.build(promptId, variables);
    const response = await llm.generate({
      system: prompt.system,
      user: prompt.user,
      signal,
      maxOutputTokens: llm.outputWindow,
    });
    const html = extractHtml(response);
    if (!html) return null;
    const processed = postProcessHtml(html);
    const configMatch = processed.match(
      /<script type="application\/json" id="widget-config">([\s\S]*?)<\/script>/,
    );
    let widgetConfig: Record<string, unknown> | undefined;
    try {
      widgetConfig = configMatch?.[1]
        ? (JSON.parse(configMatch[1]) as Record<string, unknown>)
        : undefined;
    } catch {
      widgetConfig = undefined;
    }
    return {
      html: processed,
      widgetType:
        outline.widgetType === 'procedural-skill'
          ? 'diagram'
          : (outline.widgetType ?? 'simulation'),
      widgetConfig,
    };
  }
  return null;
}

function inventory(html: string): string {
  const withoutScripts = html.replace(/<(?:script|style)\b[\s\S]*?<\/(?:script|style)>/gi, '');
  const entries = [...withoutScripts.matchAll(/<([a-z][\w-]*)\b[^>]*\bid=["']([^"']+)["'][^>]*>/gi)]
    .slice(0, 60)
    .flatMap((match) => (match[1] && match[2] ? [`#${match[2]} <${match[1].toLowerCase()}>`] : []));
  return entries.join('\n') || '(no interactive elements detected)';
}

function elementsText(elements: PPTElement[]): string {
  return elements
    .map((element) => {
      const summary =
        element.type === 'text' && 'content' in element
          ? String(element.content)
              .replace(/<[^>]*>/g, '')
              .slice(0, 50)
          : element.type;
      return `- id: "${element.id}", type: "${element.type}", content: "${summary}"`;
    })
    .join('\n');
}

function processActions(
  actions: Action[],
  content: GeneratedSceneContent,
  agents: readonly CliAgent[],
): Action[] {
  const elementIds = new Set(
    'elements' in content ? content.elements.map((element) => element.id) : [],
  );
  const fallbackAgent =
    agents.find((agent) => agent.role === 'student') ??
    agents.find((agent) => agent.role !== 'teacher');
  return actions.flatMap((action) => {
    if (
      (action.type === 'spotlight' || action.type === 'laser') &&
      !elementIds.has(action.elementId)
    )
      return [];
    if (action.type === 'discussion' && !action.agentId && fallbackAgent)
      return [{ ...action, agentId: fallbackAgent.id }];
    return [action];
  });
}

export async function generateSceneActions(
  outline: SceneOutline,
  content: GeneratedSceneContent,
  llm: LLMCaller,
  prompts: PromptRepository,
  agents: readonly CliAgent[],
  context: SceneGenerationContext,
  directive: string,
  signal?: AbortSignal,
): Promise<Action[]> {
  const common = {
    title: outline.title,
    description: outline.description,
    keyPoints: outline.keyPoints.map((point, index) => `${index + 1}. ${point}`).join('\n'),
    courseContext: courseContext(context),
    agents: agentsForPrompt(agents),
    languageDirective: languageText(directive, outline.languageNote),
    userProfile: '',
  };
  let promptId: string;
  let variables: Record<string, unknown>;
  let allowed: readonly (typeof WIDGET_ACTIONS)[number][] | undefined;
  if ('elements' in content) {
    promptId = 'slide-actions';
    variables = { ...common, elements: elementsText(content.elements) };
  } else if ('questions' in content) {
    promptId = 'quiz-actions';
    variables = {
      ...common,
      questions: content.questions
        .map((question, index) => `Q${index + 1}: ${question.question}`)
        .join('\n'),
    };
  } else {
    promptId = 'interactive-actions';
    variables = {
      ...common,
      conceptName: outline.interactiveConfig?.conceptName ?? outline.title,
      designIdea: outline.interactiveConfig?.designIdea ?? '',
      widgetType: content.widgetType ?? outline.widgetType ?? '',
      widgetConfig: JSON.stringify(content.widgetConfig ?? {}),
      elementInventory: inventory(content.html),
    };
    allowed = WIDGET_ACTIONS;
  }
  const prompt = await prompts.build(promptId, variables);
  const response = await llm.generate({
    system: prompt.system,
    user: prompt.user,
    signal,
    maxOutputTokens: llm.outputWindow,
  });
  const actions = parseActions(response, outline.type, allowed);
  if (actions.length) return processActions(actions, content, agents);
  return [
    { id: `action_${nanoid(8)}`, type: 'speech', text: outline.description || outline.title },
  ];
}

export function buildScene(
  outline: SceneOutline,
  content: GeneratedSceneContent,
  actions: Action[],
  stageId: string,
): CliScene {
  const now = Date.now();
  const core = {
    id: nanoid(),
    stageId,
    title: outline.title,
    order: outline.order,
    actions,
    createdAt: now,
    updatedAt: now,
    outlineId: outline.id,
  };
  if ('elements' in content) {
    return {
      ...core,
      type: 'slide',
      content: {
        type: 'slide',
        canvas: {
          id: nanoid(),
          viewportSize: 1000,
          viewportRatio: 0.5625,
          theme: {
            backgroundColor: '#ffffff',
            themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4'],
            fontColor: '#333333',
            fontName: 'Microsoft YaHei',
            outline: { color: '#d14424', width: 2, style: 'solid' },
            shadow: { h: 0, v: 0, blur: 10, color: '#000000' },
          },
          elements: content.elements,
          background: content.background,
        },
      },
    };
  }
  if ('questions' in content)
    return { ...core, type: 'quiz', content: { type: 'quiz', questions: content.questions } };
  return {
    ...core,
    type: 'interactive',
    content: {
      type: 'interactive',
      url: '',
      html: content.html,
      widgetType: content.widgetType,
      widgetConfig: content.widgetConfig,
    },
  };
}

export function createStage(
  title: string,
  requirement: string,
  languageDirective: string,
  agents: readonly CliAgent[],
): Stage {
  const now = Date.now();
  return {
    id: nanoid(),
    name: title || requirement.slice(0, 120) || 'OpenMAIC Classroom',
    description: requirement,
    languageDirective,
    createdAt: now,
    updatedAt: now,
    agentIds: agents.map((agent) => agent.id),
    generatedAgentConfigs: agents.map((agent) => ({ ...agent })),
  };
}
