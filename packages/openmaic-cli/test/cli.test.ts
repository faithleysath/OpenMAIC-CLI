import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const cli = resolve('dist/cli.js');

function run(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

describe('compiled CLI', () => {
  it('prints the package version', async () => {
    expect(await run(['--version'])).toMatchObject({ code: 0, stdout: '0.1.0\n', stderr: '' });
  });

  it('runs doctor without a paid probe', async () => {
    const result = await run(['doctor', '--quiet'], {
      DEFAULT_MODEL: 'ollama:test',
      OLLAMA_BASE_URL: 'http://localhost:11434/v1',
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ success: true, output: null, warnings: [] });
  });

  it('rejects non-ZIP output before generation', async () => {
    const result = await run(['outline', 'topic', '--output', 'outline.json', '--quiet'], {
      DEFAULT_MODEL: 'ollama:test',
    });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('.maic-outline.zip');
  });

  it('maps argument parser errors to exit code 2', async () => {
    const result = await run(['doctor', '--unknown-option'], { DEFAULT_MODEL: 'ollama:test' });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
  });
});
