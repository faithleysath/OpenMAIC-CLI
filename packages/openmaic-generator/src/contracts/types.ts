import type {
  Action,
  PPTElement,
  QuizQuestion,
  Scene,
  SceneContent,
  SlideBackground,
  Stage,
} from '@openmaic/dsl';

export const GENERATOR_VERSION = '0.1.0';
export const OUTLINE_FORMAT_VERSION = 1;
export const CLASSROOM_FORMAT_VERSION = 1;
export const OUTLINE_EXTENSION = '.maic-outline.zip';
export const CLASSROOM_EXTENSION = '.maic.zip';

export type SupportedCliSceneType = 'slide' | 'quiz' | 'interactive';
export type OutlineSceneType = SupportedCliSceneType | 'pbl';
export type WidgetType =
  | 'simulation'
  | 'diagram'
  | 'code'
  | 'game'
  | 'visualization3d'
  | 'procedural-skill';

export interface WidgetOutline {
  concept?: string;
  keyVariables?: string[];
  diagramType?: 'flowchart' | 'mindmap' | 'hierarchy' | 'system';
  language?: 'python' | 'javascript' | 'typescript' | 'java' | 'cpp';
  gameType?: 'quiz' | 'puzzle' | 'strategy' | 'card' | 'action';
  visualizationType?: 'molecular' | 'solar' | 'anatomy' | 'geometry' | 'physics' | 'custom';
  objects?: string[];
  interactions?: string[];
  nodeCount?: number;
  nodes?: Array<{
    id: string;
    label: string;
    parentId?: string;
    icon?: string;
    details?: string;
  }>;
  challenge?: string;
  playerControls?: string[];
}

export interface MediaGenerationRequest {
  type: 'image' | 'video';
  prompt: string;
  elementId: string;
  aspectRatio?: string;
  duration?: number;
}

export interface SceneOutline {
  id: string;
  type: OutlineSceneType;
  title: string;
  description: string;
  keyPoints: string[];
  teachingObjective?: string;
  estimatedDuration?: number;
  order: number;
  languageNote?: string;
  suggestedImageIds?: string[];
  mediaGenerations?: MediaGenerationRequest[];
  quizConfig?: {
    questionCount: number;
    difficulty: 'easy' | 'medium' | 'hard';
    questionTypes: Array<'single' | 'multiple' | 'text'>;
  };
  interactiveConfig?: {
    conceptName: string;
    conceptOverview: string;
    designIdea: string;
    subject?: string;
  };
  pblConfig?: Record<string, unknown>;
  widgetType?: WidgetType;
  widgetOutline?: WidgetOutline;
}

export interface GenerationWarning {
  code: string;
  message: string;
  sceneId?: string;
  sceneTitle?: string;
  providerId?: string;
}

export interface ResearchSource {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface ResearchSnapshot {
  providerId: string;
  query: string;
  answer?: string;
  sources: ResearchSource[];
}

export interface MaterialSnapshotEntry {
  id: string;
  kind: 'image' | 'keyframe';
  mimeType: string;
  size: number;
  sha256: string;
  path: string;
  pageNumber?: number;
  timeMs?: number;
  width?: number;
  height?: number;
  description?: string;
  sourceDocumentId?: string;
  sourceDocumentName?: string;
  sourceDocumentOrder?: number;
  visionPriority?: number;
}

export interface MaterialSnapshotManifest {
  text: string;
  totalRawTextLength: number;
  entries: MaterialSnapshotEntry[];
}

export interface OutlineDocument {
  kind: 'openmaic-outline';
  formatVersion: 1;
  generatorVersion: string;
  requirement: string;
  courseTitle?: string;
  languageDirective: string;
  outlines: SceneOutline[];
  materials?: MaterialSnapshotManifest;
  research?: ResearchSnapshot;
  warnings: GenerationWarning[];
}

export interface MaterialImage {
  id: string;
  mimeType: string;
  data: Buffer;
  pageNumber: number;
  timeMs?: number;
  width?: number;
  height?: number;
  description?: string;
  sourceDocumentId?: string;
  sourceDocumentName?: string;
  sourceDocumentOrder?: number;
  visionPriority?: number;
  kind?: 'image' | 'keyframe';
}

export interface MaterialBundle {
  text: string;
  images: MaterialImage[];
  totalRawTextLength: number;
  totalImageCount: number;
  visionImageCount: number;
}

export interface InteractiveContent {
  type: 'interactive';
  url: string;
  html?: string;
  widgetType?: WidgetType;
  widgetConfig?: Record<string, unknown>;
}

export type CliSceneContent = SceneContent | InteractiveContent;
export type CliScene = Scene<Action, CliSceneContent> & { outlineId?: string };

export interface CliAgent {
  id: string;
  name: string;
  role: string;
  persona: string;
  avatar: string;
  color: string;
  priority: number;
}

export interface AssetManifestEntry {
  ref: string;
  type: 'image' | 'video' | 'audio';
  mimeType: string;
  size: number;
  prompt?: string;
  duration?: number;
  missing?: boolean;
}

export interface GeneratedAssetBlob extends AssetManifestEntry {
  data: Buffer;
}

export interface SceneGenerationDocument {
  kind: 'openmaic-scenes';
  formatVersion: 1;
  generatorVersion: string;
  id: string;
  createdAt: string;
  requirement: string;
  languageDirective: string;
  courseTitle?: string;
  stage: Stage;
  outlines: SceneOutline[];
  scenes: CliScene[];
  agents: CliAgent[];
  assets: AssetManifestEntry[];
  research?: ResearchSnapshot;
  warnings: GenerationWarning[];
}

export interface CourseGenerationDocument extends Omit<SceneGenerationDocument, 'kind'> {
  kind: 'openmaic-classroom';
}

export interface OutlineGenerationResult {
  document: Omit<OutlineDocument, 'materials'>;
  materialBundle?: MaterialBundle;
}

export interface SceneGenerationResult {
  document: SceneGenerationDocument;
  assetBlobs: GeneratedAssetBlob[];
}

export interface CourseGenerationResult {
  document: CourseGenerationDocument;
  assetBlobs: GeneratedAssetBlob[];
}

export interface GeneratedSlideContent {
  elements: PPTElement[];
  background?: SlideBackground;
  remark?: string;
}

export interface GeneratedQuizContent {
  questions: QuizQuestion[];
}

export interface GeneratedInteractiveContent {
  html: string;
  widgetType?: WidgetType;
  widgetConfig?: Record<string, unknown>;
}

export type GeneratedSceneContent =
  | GeneratedSlideContent
  | GeneratedQuizContent
  | GeneratedInteractiveContent;

export interface OperationOptions {
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
}

export type ProgressEvent =
  | { type: 'preflight'; message: string }
  | { type: 'extract'; current: number; total: number; file: string }
  | { type: 'search'; providerId: string; query: string }
  | { type: 'outline'; phase: 'start' | 'complete' }
  | {
      type: 'scene';
      phase: 'content' | 'actions' | 'complete' | 'failed';
      current: number;
      total: number;
      sceneId: string;
      title: string;
    }
  | { type: 'asset'; phase: 'start' | 'complete' | 'failed'; ref: string };

export interface GenerateOutlineInput extends OperationOptions {
  requirement: string;
  materials?: MaterialBundle;
  research?: ResearchSnapshot;
  allowedSceneTypes?: SupportedCliSceneType[];
  interactiveMode?: boolean;
  webSearch?: boolean;
  strictSearch?: boolean;
  imageGenerationEnabled?: boolean;
  videoGenerationEnabled?: boolean;
}

export interface GenerateSceneInput extends OperationOptions {
  outline: OutlineDocument | OutlineGenerationResult;
  scene?: string | number | 'all';
  image?: boolean;
  video?: boolean;
  tts?: boolean;
  strictMedia?: boolean;
}

export interface GenerateCourseInput extends OperationOptions {
  requirement: string;
  materialPaths?: string[];
  materials?: MaterialBundle;
  webSearch?: boolean;
  interactiveMode?: boolean;
  strictSearch?: boolean;
  image?: boolean;
  video?: boolean;
  tts?: boolean;
  strictMedia?: boolean;
}

export interface ExtractMaterialsInput extends OperationOptions {
  paths: string[];
  providerId?: string;
}
