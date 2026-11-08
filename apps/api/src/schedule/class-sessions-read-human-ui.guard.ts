import { BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { configuredPublicOrigin } from '@hon/auth';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { forwardedHostMatchesPublicOrigin } from './same-origin-proxy.js';

const AUTHORITY_HEADERS = new Set([
  'authorization', 'forwarded', 'x-forwarded-for', 'x-forwarded-port', 'x-forwarded-proto',
  'x-real-ip', 'x-original-url', 'x-rewrite-url', 'x-subject', 'x-user-id', 'x-principal-id',
  'x-organization-id', 'x-school-id', 'x-role', 'x-tier', 'x-source',
  'x-delegated-by-principal-id', 'x-action-request-id', 'idempotency-key',
]);

/** Room for the longest valid selector set (a 512-character cursor, a date and a limit) and nothing more. */
const MAX_RAW_QUERY_LENGTH = 600;

/** Browser transport is strict, but database function authorization remains authoritative. */
@Injectable()
export class ClassSessionsReadHumanUiGuard implements CanActivate {
  /** Query keys a subclass accepts (each at most once, as a plain string); the bounded read accepts none. */
  protected readonly allowedQuery: ReadonlySet<string> = new Set();

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<HonRequest>();
    http.getResponse()?.setHeader?.('Cache-Control', 'private, no-store');
    http.getResponse()?.setHeader?.('Referrer-Policy', 'no-referrer');
    http.getResponse()?.setHeader?.('X-Robots-Tag', 'noindex, nofollow');

    let origin: string | undefined;
    try { origin = configuredPublicOrigin(process.env); } catch { /* fail closed */ }
    if (!origin) throw new ServiceUnavailableException({ code: 'HUMAN_UI_ORIGIN_NOT_CONFIGURED' });

    const headers = request.headers;
    const query = (request.query ?? {}) as Record<string, unknown>;
    const hasSelector = this.allowedQuery.size === 0
      ? Object.keys(query).length > 0 || request.originalUrl?.includes('?')
      : !this.rawQueryAccepted(request.originalUrl ?? request.url ?? '', query);
    const unexpectedHonHeader = Object.keys(headers).some((header) => {
      const name = header.toLowerCase();
      return name.startsWith('x-hon-') && name !== 'x-hon-human-read';
    });
    const authorityHeader = Object.keys(headers).some((header) => AUTHORITY_HEADERS.has(header.toLowerCase()));
    const hasBody = request.body !== undefined && request.body !== null;
    if (hasSelector || hasBody || headers['transfer-encoding'] !== undefined
      || (headers['content-length'] !== undefined && headers['content-length'] !== '0')) {
      throw new BadRequestException({ code: 'CLASS_SESSIONS_READ_SELECTORS_NOT_ACCEPTED' });
    }
    // Browsers omit Origin on same-origin GET (Fetch standard), so it is optional here but must match when
    // present; the forbidden Sec-Fetch-* metadata plus the custom read header (which forces a CORS preflight
    // Nest never grants) carry the same-origin proof. POST commands still require Origin.
    if (request.method !== 'GET' || (headers.origin !== undefined && headers.origin !== origin)
      || !forwardedHostMatchesPublicOrigin(headers['x-forwarded-host'], origin)
      || headers['x-hon-human-read'] !== 'class-sessions'
      || headers['sec-fetch-site'] !== 'same-origin' || headers['sec-fetch-mode'] !== 'same-origin'
      || headers['sec-fetch-dest'] !== 'empty' || headers['sec-fetch-user'] !== undefined
      || unexpectedHonHeader || authorityHeader) {
      throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    }
    return true;
  }

  /**
   * The parsed query alone is not enough: Express's parser stops after 1,000 pairs, so padding could hide an extra,
   * repeated or malformed selector from it. The complete raw query must be a short list of distinct allowed keys, each
   * once with a value, no empty pairs, decoding cleanly, and exactly matching the parsed query.
   */
  private rawQueryAccepted(url: string, parsed: Record<string, unknown>): boolean {
    const mark = url.indexOf('?');
    if (mark < 0) return Object.keys(parsed).length === 0;
    const raw = url.slice(mark + 1);
    if (raw.length > MAX_RAW_QUERY_LENGTH || raw.includes('#')) return false;
    const seen = new Map<string, string>();
    for (const pair of raw.split('&')) {
      const equals = pair.indexOf('=');
      if (equals <= 0) return false;
      let key: string, value: string;
      try {
        key = decodeURIComponent(pair.slice(0, equals).replaceAll('+', ' '));
        value = decodeURIComponent(pair.slice(equals + 1).replaceAll('+', ' '));
      } catch { return false; }
      if (!this.allowedQuery.has(key) || seen.has(key)) return false;
      seen.set(key, value);
    }
    const keys = Object.keys(parsed);
    return keys.length === seen.size && keys.every((key) => parsed[key] === seen.get(key));
  }
}
