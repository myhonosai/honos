import { raw, type Request, type Response, type NextFunction } from 'express';

/** JSON.parse supplies grammar validation; the token pass additionally rejects duplicate object keys. */
export function parsePublicFormJson(buffer: Buffer): unknown {
  if (buffer.length > 8192 || buffer.length === 0) throw new Error('INVALID');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  const parsed: unknown = JSON.parse(text);
  const stack: Array<{ object: boolean; key: boolean; keys: Set<string> }> = [];
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g)) {
    const token = match[0], top = stack.at(-1);
    if (token === '{' || token === '[') stack.push({ object: token === '{', key: token === '{', keys: new Set() });
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',' && top?.object) top.key = true;
    else if (token.startsWith('"') && top?.object && top.key) {
      const key = JSON.parse(token) as string;
      if (top.keys.has(key)) throw new Error('INVALID');
      top.keys.add(key); top.key = false;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID');
  return parsed;
}
export function publicFormTransport() {
  const parser = raw({ type: () => true, limit: 8192, inflate: false });
  let start = Date.now(), attempts = 0;
  return (req: Request, res: Response, next: NextFunction): void => {
    // Nest/Express routing is case-insensitive: catch variants, but accept only canonical paths.
    if (!/^\/v1\/public\/forms(?:\/|$)/i.test(req.path)) { next(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.originalUrl.includes('?')) { res.status(400).json({ result: 'invalid' }); return; }
    if (req.method === 'GET') {
      if (!/^\/v1\/public\/forms\/[a-f0-9]{48}$/.test(req.path) || req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) !== 0) { res.status(400).json({ result: 'invalid' }); return; }
      next(); return;
    }
    if (req.method !== 'POST' || !/^\/v1\/public\/forms\/[a-f0-9]{48}\/submissions$/.test(req.path)) { res.status(400).json({ result: 'invalid' }); return; }
    if (Date.now() - start >= 60000) { start = Date.now(); attempts = 0; }
    // Fixed memory; not an IP limiter. Persistent per-form + both contact limits are enforced in SQL.
    if (++attempts > 300) { res.setHeader('Retry-After', '60'); res.status(429).json({ result: 'rate-limited' }); return; }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')
      || (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity')) { res.status(400).json({ result: 'invalid' }); return; }
    parser(req, res, error => {
      if (error) { res.status(400).json({ result: 'invalid' }); return; }
      try { req.body = parsePublicFormJson(req.body as Buffer); }
      catch { res.status(400).json({ result: 'invalid' }); return; }
      next();
    });
  };
}
