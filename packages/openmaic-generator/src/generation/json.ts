import { jsonrepair } from 'jsonrepair';

function stripReasoning(text: string): string {
  const trimmed = text.trim();
  const matches = [...trimmed.matchAll(/<\/(?:think|thinking|reasoning)>\s*/gi)];
  const last = matches.at(-1);
  return last?.index === undefined ? trimmed : trimmed.slice(last.index + last[0].length).trim();
}

export function parseJsonResponse<T>(response: string): T | null {
  const cleaned = stripReasoning(response);
  const candidates = [cleaned];
  for (const match of cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1] !== undefined) candidates.unshift(match[1].trim());
  }
  const objectStart = Math.min(
    ...[cleaned.indexOf('{'), cleaned.indexOf('[')].filter((index) => index >= 0),
  );
  if (Number.isFinite(objectStart)) candidates.push(cleaned.slice(objectStart));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      try {
        return JSON.parse(jsonrepair(candidate)) as T;
      } catch {
        // Try the next candidate.
      }
    }
  }
  return null;
}
