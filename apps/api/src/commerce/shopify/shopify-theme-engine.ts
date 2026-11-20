import type { ShopifyThemeFileDiff, ShopifyThemeRef } from '@hon/contracts';
import { ShopifyProviderError, type ShopifyApp, type ShopifyTheme, type ShopifyThemeFile } from './shopify-adapter.js';
import { FAILURE_CODE, SHOPIFY_REFRESH_MARGIN_MS } from './shopify-sync-engine.js';
import { applyThemeRecipe, THEME_RECIPE_FILES, themeRecipe, type ThemeFileChange, type ThemeRecipe } from './shopify-theme-recipes.js';

/** What begin_shopify_theme_work hands the API: the work, its lease, the store and its sealed credential. */
export interface BegunThemeWork {
  purpose: 'PREVIEW' | 'APPLY' | 'UNDO'; leaseToken: string; connectionId: string; shopDomain: string; recipe: ThemeRecipe;
  editId: string | null; restore: ThemeFileChange[] | null; baseTheme: ShopifyThemeRef | null; draftTheme: ShopifyThemeRef | null;
  credential: { keyId: string; sealed: string; version: number };
}
const ref = (v: unknown): ShopifyThemeRef | null | undefined => {
  if (v === null) return null;
  const o = v as Record<string, unknown> | null;
  return o && typeof o.id === 'string' && /^[1-9][0-9]{0,17}$/.test(o.id) && typeof o.name === 'string' ? { id: o.id, name: o.name } : undefined;
};
/** The begin answer, or null when it is not the shape HON expects. */
export function begunThemeWork(v: unknown): BegunThemeWork | null {
  const o = v as Record<string, unknown> | null, k = (o?.credential ?? null) as Record<string, unknown> | null;
  if (!o || !k || (o.purpose !== 'PREVIEW' && o.purpose !== 'APPLY' && o.purpose !== 'UNDO') || typeof o.leaseToken !== 'string'
    || typeof o.connectionId !== 'string' || typeof o.shopDomain !== 'string' || typeof k.keyId !== 'string' || typeof k.sealed !== 'string'
    || !Number.isInteger(k.version) || (o.purpose === 'PREVIEW') !== (o.editId === null) || (o.editId !== null && typeof o.editId !== 'string')) return null;
  const recipe = themeRecipe(o.recipe && o.inputs && typeof o.inputs === 'object' ? { recipe: o.recipe, ...(o.inputs as object) } : null);
  const baseTheme = ref(o.baseTheme), draftTheme = ref(o.draftTheme);
  if (!recipe || baseTheme === undefined || draftTheme === undefined) return null;
  let restore: ThemeFileChange[] | null = null;
  if (o.purpose === 'UNDO') {
    if (!Array.isArray(o.restore) || !draftTheme) return null;
    restore = [];
    for (const f of o.restore as unknown[]) {
      const e = f as Record<string, unknown> | null;
      if (!e || typeof e.filename !== 'string' || typeof e.before !== 'string' || typeof e.after !== 'string') return null;
      restore.push({ filename: e.filename, before: e.before, after: e.after });
    }
  } else if (o.restore !== null) return null;
  return { purpose: o.purpose, leaseToken: o.leaseToken, connectionId: o.connectionId, shopDomain: o.shopDomain, recipe, editId: o.editId as string | null,
    restore, baseTheme, draftTheme, credential: { keyId: k.keyId, sealed: k.sealed, version: k.version as number } };
}

export type ThemeOutcome = 'DONE' | 'APPLIED' | 'FAILED' | 'UNKNOWN';
export interface ThemeFinish {
  outcome: ThemeOutcome; failureCode: string | null; baseTheme: ShopifyThemeRef | null; draftTheme: ShopifyThemeRef | null; files: ThemeFileChange[] | null;
}
export interface ThemeSteps<T> {
  rotate(body: { expectedVersion: number; credential: { keyId: string; sealed: string; accessExpiresAt: string; refreshExpiresAt: string } }): Promise<unknown>;
  finish(f: ThemeFinish, preview: { target: ShopifyThemeRef; files: ShopifyThemeFileDiff[] } | null): Promise<T>;
}

/** The copy's name in Shopify: "HON draft - <live theme>", at most 50 characters. */
export function draftName(live: string): string { return ('HON draft - ' + live).slice(0, 50).trim(); }
const diff = (files: ThemeFileChange[]): ShopifyThemeFileDiff[] => files.map(f => ({ ...f, changed: f.before !== f.after }));

/**
 * One piece of theme work under its lease. Never writes to the live (MAIN) theme: APPLY makes (once) an UNPUBLISHED copy of
 * the live theme and writes there; UNDO writes back the contents an earlier edit replaced, only when the copy still has what
 * that edit wrote. A write whose result HON cannot tell is UNKNOWN, never FAILED. Tokens stay in memory.
 */
export async function runThemeWork<T>(app: ShopifyApp, now: () => number, w: BegunThemeWork, steps: ThemeSteps<T>): Promise<T> {
  const binding = { connectionId: w.connectionId, shopDomain: w.shopDomain }, shop = w.shopDomain;
  let base = w.baseTheme, draft = w.draftTheme;
  const end = (outcome: ThemeOutcome, failureCode: string | null, files: ThemeFileChange[] | null = null,
    preview: { target: ShopifyThemeRef; files: ShopifyThemeFileDiff[] } | null = null) =>
    steps.finish({ outcome, failureCode, baseTheme: base, draftTheme: w.purpose === 'PREVIEW' ? null : draft, files }, preview);
  const failed = 'FAILED' as const;
  let credential;
  try { credential = app.vault.open(binding, w.credential.keyId, w.credential.sealed); } catch { return end(failed, 'CREDENTIAL_UNREADABLE'); }
  let token = credential.accessToken;
  let live: ShopifyTheme | undefined, files: ShopifyThemeFile[];
  // Reads only so far: any provider failure means nothing was written.
  try {
    if (Date.parse(credential.accessExpiresAt) - now() < SHOPIFY_REFRESH_MARGIN_MS) {
      if (Date.parse(credential.refreshExpiresAt) <= now()) return await end(failed, 'REFRESH_EXPIRED');
      const fresh = await app.adapter.refresh(shop, credential.refreshToken);
      const pair = { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, accessExpiresAt: fresh.accessExpiresAt, refreshExpiresAt: fresh.refreshExpiresAt };
      await steps.rotate({ expectedVersion: w.credential.version,
        credential: { keyId: app.vault.keyId, sealed: app.vault.seal(binding, pair), accessExpiresAt: pair.accessExpiresAt, refreshExpiresAt: pair.refreshExpiresAt } });
      token = pair.accessToken;
    }
    const themes = await app.adapter.themes(shop, token);
    live = themes.find(t => t.role === 'MAIN');
    if (!live) return await end(failed, 'NO_LIVE_THEME');
    if (!base) base = { id: live.id, name: live.name };
    if (draft && !themes.some(t => t.id === draft!.id && t.role === 'UNPUBLISHED')) return await end(failed, 'DRAFT_THEME_MISSING');
    const target = draft ?? { id: live.id, name: live.name };
    const names = w.purpose === 'UNDO' ? w.restore!.map(f => f.filename) : [...THEME_RECIPE_FILES[w.recipe.recipe]];
    files = await app.adapter.themeFiles(shop, token, target.id, names);
    if (w.purpose === 'PREVIEW') {
      const r = applyThemeRecipe(w.recipe, files);
      if (!r.ok) return await end('FAILED', r.problem);
      return await end('DONE', null, null, { target, files: diff(r.files) });
    }
  } catch (e) {
    if (e instanceof ShopifyProviderError) return end(failed, FAILURE_CODE[e.failure]);
    throw e;
  }

  let changes: ThemeFileChange[];
  if (w.purpose === 'UNDO') {
    if (w.restore!.some(r => files.find(f => f.filename === r.filename)?.content !== r.after)) return end('FAILED', 'CHANGED_SINCE');
    changes = w.restore!.map(r => ({ filename: r.filename, before: r.after, after: r.before }));
  } else {
    const r = applyThemeRecipe(w.recipe, files);
    if (!r.ok) return end('FAILED', r.problem);
    changes = r.files;
  }

  if (!draft) {
    try {
      const copy = await app.adapter.duplicateTheme(shop, token, live.id, draftName(live.name));
      draft = { id: copy.id, name: copy.name };
    } catch (e) {
      if (!(e instanceof ShopifyProviderError)) throw e;
      // Refused: no copy was made. Anything else: Shopify may have made one HON does not know about.
      return end(e.failure === 'REJECTED' || e.failure === 'AUTH' || e.failure === 'RATE_LIMITED' ? 'FAILED' : 'UNKNOWN', 'DUPLICATE_' + FAILURE_CODE[e.failure].replace(/^SHOPIFY_/, ''));
    }
  }
  const toWrite = changes.filter(c => c.before !== c.after);
  if (toWrite.length) {
    try { await app.adapter.upsertThemeFiles(shop, token, draft.id, toWrite.map(c => ({ filename: c.filename, content: c.after }))); }
    catch (e) {
      if (!(e instanceof ShopifyProviderError)) throw e;
      const refused = e.failure === 'REJECTED' || e.failure === 'AUTH' || e.failure === 'RATE_LIMITED';
      return end(refused ? 'FAILED' : 'UNKNOWN', FAILURE_CODE[e.failure]);
    }
  }
  return end('APPLIED', null, changes);
}
