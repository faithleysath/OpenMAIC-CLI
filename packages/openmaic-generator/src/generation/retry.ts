import { throwIfAborted } from '../errors.js';

function retryable(error: unknown): boolean {
  const status =
    error && typeof error === 'object' && 'status' in error
      ? Number((error as { status: unknown }).status)
      : undefined;
  if (status && (status === 429 || status >= 500)) return true;
  return /timeout|timed out|fetch failed|network|ECONNRESET|ETIMEDOUT/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: { signal?: AbortSignal; retries?: number; retryEmpty?: (value: T) => boolean } = {},
): Promise<T> {
  const attempts = (options.retries ?? 3) + 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      const result = await operation();
      if (!options.retryEmpty?.(result) || attempt === attempts) return result;
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !retryable(error)) throw error;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, Math.min(8_000, 500 * 2 ** (attempt - 1)));
      options.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  }
  throw lastError;
}
