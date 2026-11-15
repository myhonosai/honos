import 'server-only';
import { verifyPublishedSchoolWebsite, websiteSlugOk, type PublishedSchoolWebsite } from '@hon/contracts';

/** WB3: the deployment-owned API base is the only network destination; the address is validated before any request. */
function apiBase(): string {
  const configured = process.env.HON_API_BASE_URL ?? 'http://127.0.0.1:3001';
  const parsed = new URL(configured);
  if (configured !== configured.trim() || !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Site unavailable.');
  return parsed.href.replace(/\/$/, '');
}

const MAX_BYTES = 300 * 1024;
export type PublicSiteResult = { kind: 'site'; site: PublishedSchoolWebsite } | { kind: 'missing' } | { kind: 'unavailable' };

/** Reads one published school website. Unknown or offline is 'missing'; any other failure is 'unavailable', never a fake page. */
export async function readPublicSite(slug: string, fetcher: typeof fetch = fetch): Promise<PublicSiteResult> {
  if (!websiteSlugOk(slug)) return { kind: 'missing' };
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 8000);
  try {
    const response = await fetcher(`${apiBase()}/v1/public/sites/${slug}`, { method: 'GET', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json' }, signal: abort.signal });
    if (response.status === 404) { await response.body?.cancel(); return { kind: 'missing' }; }
    if (response.status !== 200 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '') || !response.body) {
      await response.body?.cancel(); return { kind: 'unavailable' };
    }
    const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0, text = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) { await reader.cancel(); return { kind: 'unavailable' }; }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const body = JSON.parse(text) as unknown;
    if (!body || typeof body !== 'object' || Object.keys(body).join(',') !== 'data') return { kind: 'unavailable' };
    return { kind: 'site', site: verifyPublishedSchoolWebsite((body as { data: unknown }).data, slug) };
  } catch { return { kind: 'unavailable' }; }
  finally { clearTimeout(timer); }
}
