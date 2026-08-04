export type OpenMaicErrorCode =
  | 'INVALID_ARGUMENT'
  | 'CONFIG_ERROR'
  | 'MATERIAL_ERROR'
  | 'PROVIDER_ERROR'
  | 'GENERATION_ERROR'
  | 'ARCHIVE_ERROR';

export class OpenMaicError extends Error {
  constructor(
    readonly code: OpenMaicErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'OpenMaicError';
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function redactSensitive(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:api_?key|key|token|access_token|authorization)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
}
