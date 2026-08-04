import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuiltPrompt {
  system: string;
  user: string;
}

export interface PromptRepository {
  build(id: string, variables: Record<string, unknown>): Promise<BuiltPrompt>;
}

function interpolate(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = variables[key];
    if (value === undefined) return match;
    return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  });
}

function conditionals(template: string, variables: Record<string, unknown>): string {
  return template.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, key: string, content: string) => (variables[key] ? content : ''),
  );
}

export class FilePromptRepository implements PromptRepository {
  readonly root: string;

  constructor(root = fileURLToPath(new URL('./prompts/', import.meta.url))) {
    this.root = root;
  }

  async build(id: string, variables: Record<string, unknown>): Promise<BuiltPrompt> {
    const templateRoot = join(this.root, 'templates', id);
    const system = await this.readTemplate(join(templateRoot, 'system.md'), true);
    const user = await this.readTemplate(join(templateRoot, 'user.md'), false);
    return {
      system: interpolate(conditionals(system, variables), variables),
      user: interpolate(conditionals(user, variables), variables),
    };
  }

  private async readTemplate(path: string, required: boolean): Promise<string> {
    try {
      const source = (await readFile(path, 'utf8')).trim();
      return this.expandSnippets(source);
    } catch (error) {
      if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  }

  private async expandSnippets(source: string): Promise<string> {
    const matches = [...source.matchAll(/\{\{snippet:([\w-]+)\}\}/g)];
    let output = source;
    for (const match of matches) {
      const snippet = (
        await readFile(join(this.root, 'snippets', `${match[1]}.md`), 'utf8')
      ).trim();
      output = output.replaceAll(match[0], snippet);
    }
    return output;
  }
}
