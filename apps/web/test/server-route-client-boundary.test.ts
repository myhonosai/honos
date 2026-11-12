import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Next.js refuses, at request time, a Server Component that calls a plain function exported from a
// 'use client' module (the import becomes a client reference). Unit tests render outside that boundary,
// so this source check is what catches it before a route returns HTTP 500.
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);
}
const isClient = (source: string) => /^\s*['"]use client['"]/.test(source);
function clientFunctionCalls(): string[] {
  const found: string[] = [];
  for (const file of files('src/app').filter(f => /(page|layout)\.tsx?$/.test(f))) {
    const source = readFileSync(file, 'utf8');
    if (isClient(source)) continue;
    for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
      const base = resolve(dirname(file), m[2]!);
      const target = [base + '.tsx', base + '.ts', join(base, 'index.tsx'), join(base, 'index.ts')].find(existsSync);
      if (!target || !isClient(readFileSync(target, 'utf8'))) continue;
      for (const name of m[1]!.split(',').map(s => s.trim().split(/\s+as\s+/).pop()!).filter(Boolean)) {
        if (new RegExp(`[^<\\w.]${name}\\(`).test(source)) found.push(`${file}: ${name}()`);
      }
    }
  }
  return found;
}

describe('server routes and client modules', () => {
  it('no server page or layout calls a function exported from a client module', () => {
    expect(clientFunctionCalls()).toEqual([]);
  });

  it('in-app links point at real pages (there is no /staff index page)', () => {
    const pages = new Set(files('src/app').filter(f => /page\.tsx?$/.test(f)).map(f => '/' + f.replace(/^src\/app\/?/, '').replace(/\/?page\.tsx?$/, '')).map(p => p === '/' ? '/' : p));
    expect(pages.has('/staff')).toBe(false);
    const dead = files('src/components').filter(f => /\.tsx$/.test(f))
      .flatMap(f => [...readFileSync(f, 'utf8').matchAll(/href=["'](\/(?:staff|hq|account|parent)[^"'?#]*)["']/g)].map(m => [f, m[1]!] as const))
      .filter(([, href]) => !pages.has(href.replace(/\/$/, '')));
    expect(dead).toEqual([]);
  });
});
