/**
 * 0696 (HQ goes inside a school) rewrites the HQ-login refusal in 63 school functions so a live HQ visit lets the HQ
 * person through: `NOT EXISTS(...hq_operator_grants...)` becomes `(NOT EXISTS(...) OR hon.hq_visit_active(p))` and a
 * positive `EXISTS(...)` refusal becomes `(EXISTS(...) AND NOT hon.hq_visit_active(p))`. Proofs that pin a body exactly
 * against the migration that wrote it expect that body with the same rewrite, byte for byte. The rewrite rows are read
 * from 0696 itself, so this helper and the migration cannot drift apart.
 */
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../migrations/0696_hq_enter_school.sql', import.meta.url), 'utf8');
const block = source.slice(source.indexOf('INSERT INTO hq_visit_lift(sig, old, principal, negated, n) VALUES'), source.indexOf('DO $lift$'));
const rows = [...block.matchAll(/\('(hon\.[a-z_0-9]+\([^)]*\))', \$q\$([\s\S]*?)\$q\$, '([^']+)', (true|false), (\d+)\)/g)]
  .map(([, sig, old, principal, negated, n]) => ({ sig, name: sig.replace(/^hon\./, '').replace(/\(.*$/, ''), old, principal, negated: negated === 'true', n: Number(n) }));
if (new Set(rows.map(r => r.sig)).size !== 63) throw new Error(`0696 lift rows parse: expected 63 functions, got ${new Set(rows.map(r => r.sig)).size}`);
export const HQ_VISIT_LIFTED = Object.freeze([...new Set(rows.map(r => r.sig))]);

/** The installed body of `name` (bare, hon.-prefixed or a full signature) after 0696, given its body before 0696. */
export function bodyAfterHqVisit(name, body) {
  const text = String(name).replace(/^hon\./, '');
  const mine = rows.filter(r => (text.includes('(') ? r.sig === `hon.${text}` : r.name === text));
  if (typeof body !== 'string' || mine.length === 0) return body;
  if (new Set(mine.map(r => r.sig)).size !== 1) throw new Error(`0696 lift: ${text} is ambiguous; pass the full signature`);
  let out = body;
  for (const r of [...mine].sort((a, b) => b.old.length - a.old.length || (a.old < b.old ? -1 : 1))) {
    const count = out.split(r.old).length - 1;
    if (count !== r.n) throw new Error(`0696 lift: ${r.sig} has ${count} copies of a check (expected ${r.n})`);
    out = out.split(r.old).join(r.negated ? `(${r.old} OR hon.hq_visit_active(${r.principal}))` : `(${r.old} AND NOT hon.hq_visit_active(${r.principal}))`);
  }
  return out;
}
