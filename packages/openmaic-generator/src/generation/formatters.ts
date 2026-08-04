import type { CliAgent, MaterialImage } from '../contracts/types.js';

export interface SceneGenerationContext {
  pageIndex: number;
  totalPages: number;
  allTitles: string[];
  previousSpeeches: string[];
}

export function imageDescription(image: MaterialImage, attached = false): string {
  const dimensions =
    image.width && image.height
      ? ` | size: ${image.width}x${image.height} (aspect ratio ${(image.width / image.height).toFixed(2)})`
      : '';
  const source = image.sourceDocumentName ? ` from ${image.sourceDocumentName}` : '';
  const description = image.description ? ` | ${image.description}` : '';
  return `- **${image.id}**: image${source} page ${image.pageNumber}${dimensions}${description}${attached ? ' [see attached]' : ''}`;
}

export function courseContext(context?: SceneGenerationContext): string {
  if (!context) return '';
  const lines = ['Course Outline:'];
  context.allTitles.forEach((title, index) => {
    lines.push(`  ${index + 1}. ${title}${index === context.pageIndex - 1 ? ' <- current' : ''}`);
  });
  lines.push(
    '',
    'All pages belong to the same class session. Do not greet again after the first page.',
  );
  if (context.pageIndex === 1)
    lines.push('This is the first page. Open with a brief greeting and course introduction.');
  else if (context.pageIndex === context.totalPages)
    lines.push('This is the last page. Continue naturally, summarize, and close.');
  else
    lines.push(`This is page ${context.pageIndex} of ${context.totalPages}. Continue naturally.`);
  const previous = context.previousSpeeches.at(-1);
  if (previous) lines.push('', `Previous page speech: "...${previous.slice(-150)}"`);
  return lines.join('\n');
}

export function agentsForPrompt(agents: readonly CliAgent[]): string {
  return [
    'Classroom Agents:',
    ...agents.map(
      (agent) =>
        `- id: "${agent.id}", name: "${agent.name}", role: ${agent.role} - ${agent.persona}`,
    ),
  ].join('\n');
}

export function teacherForPrompt(agents: readonly CliAgent[]): string {
  const teacher = agents.find((agent) => agent.role === 'teacher');
  return teacher
    ? `Teacher Persona:\nName: ${teacher.name}\n${teacher.persona}\n\nAdapt the content style to this persona, but do not put the teacher identity on slides.`
    : '';
}

export function languageText(directive?: string, note?: string): string {
  return [directive, note ? `Additional language note for this scene: ${note}` : undefined]
    .filter(Boolean)
    .join('\n\n');
}
