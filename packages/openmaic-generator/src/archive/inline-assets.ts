import { createNetworkAdapter, readResponseBuffer, readResponseText } from '../network.js';

export interface InlineReport {
  inlined: string[];
  failed: Array<{ url: string; reason: string }>;
}

function remote(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export async function inlineHtmlAssets(
  html: string,
  signal?: AbortSignal,
): Promise<{ html: string; report: InlineReport }> {
  const report: InlineReport = { inlined: [], failed: [] };
  const fetcher = createNetworkAdapter({ timeoutMs: 30_000, maxResponseBytes: 10 * 1024 * 1024 });
  let output = html;
  const replacements: Array<Promise<void>> = [];

  for (const match of html.matchAll(
    /<(img|script)\b([^>]*?)\s(src)=["']([^"']+)["']([^>]*)>(?:<\/script>)?/gi,
  )) {
    const [whole, tag, before, attr, url, after] = match;
    if (!whole || !tag || before === undefined || !attr || !url || after === undefined) continue;
    if (!remote(url)) continue;
    replacements.push(
      (async () => {
        try {
          const response = await fetcher(url, { signal, redirect: 'manual' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          if (tag.toLowerCase() === 'script') {
            const code = await readResponseText(response, 5 * 1024 * 1024);
            output = output.replace(whole, `<script${before}${after}>${code}</script>`);
          } else {
            const data = await readResponseBuffer(response, 10 * 1024 * 1024);
            const mime =
              response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream';
            output = output.replace(
              whole,
              `<${tag}${before} ${attr}="data:${mime};base64,${data.toString('base64')}"${after}>`,
            );
          }
          report.inlined.push(url);
        } catch (error) {
          report.failed.push({
            url,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      })(),
    );
  }
  for (const match of html.matchAll(/<link\b([^>]*?)href=["']([^"']+)["']([^>]*)>/gi)) {
    const [whole, before, url, after] = match;
    if (!whole || before === undefined || !url || after === undefined) continue;
    if (!remote(url) || !/stylesheet/i.test(whole)) continue;
    replacements.push(
      (async () => {
        try {
          const response = await fetcher(url, { signal, redirect: 'manual' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          output = output.replace(
            whole,
            `<style data-openmaic-source="${url.replace(/"/g, '&quot;')}">${await readResponseText(response, 5 * 1024 * 1024)}</style>`,
          );
          report.inlined.push(url);
        } catch (error) {
          report.failed.push({
            url,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      })(),
    );
  }
  await Promise.all(replacements);
  return { html: output, report };
}
