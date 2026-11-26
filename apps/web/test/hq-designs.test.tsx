import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { SAAS_COMMANDS, blankCreativeDesignDocument } from '@hon/contracts';

vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ preferences: { language: 'en' } }) }));

import { HQ_BRAND, HQ_DESIGNS_API, HQ_DESIGNS_SCOPE, HqDesigns } from '../src/components/hq-creative/hq-designs';
import { DesignsAccessError, DesignsRefusal } from '../src/components/design-editor/http';
import { designText, type DesignKey } from '../src/components/design-editor/copy';
import { HQ_DESIGN_WORDS } from '../src/components/design-editor/words';

const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const at = '2026-11-24T10:00:00.000Z';
const ok = (data: unknown, replayed = false) => Response.json({ data, meta: { replayed } }, { status: 200 });
const BASE = '/api/v1/hq/marketing/creative/designs';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('reads and saves HQ designs at the HQ address with the HQ command names, never a school address', async () => {
  const design = { designId: id('d'), name: 'HON OS launch', sizeCode: 'SOCIAL_SQUARE', status: 'ACTIVE', version: 1, createdAt: at, updatedAt: at,
    document: blankCreativeDesignDocument('SOCIAL_SQUARE') };
  const f = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'GET') return url.endsWith(BASE) ? ok({ designs: [] }) : ok(design);
    return ok(design);
  });
  vi.stubGlobal('fetch', f);
  await HQ_DESIGNS_API.list(HQ_DESIGNS_SCOPE, {});
  await HQ_DESIGNS_API.save(HQ_DESIGNS_SCOPE, { designId: null, expectedVersion: 0, name: 'HON OS launch', sizeCode: 'SOCIAL_SQUARE',
    document: blankCreativeDesignDocument('SOCIAL_SQUARE') }, id('9'));
  const [listUrl] = f.mock.calls[0] as unknown as [string, RequestInit];
  const [saveUrl, saveInit] = f.mock.calls[1] as unknown as [string, RequestInit];
  expect(listUrl).toBe(BASE); expect(saveUrl).toBe(BASE);
  expect(saveInit.headers).toMatchObject({ 'X-HON-Human-Command': SAAS_COMMANDS.saveHqCreativeDesign, 'Idempotency-Key': id('9') });
  expect(f.mock.calls.every(c => !String(c[0]).includes('/schools/'))).toBe(true);
  expect([SAAS_COMMANDS.saveHqCreativeDesign, SAAS_COMMANDS.setHqCreativeDesignStatus, SAAS_COMMANDS.addHqCreativeDesignPhoto])
    .toEqual(['hq-creative-design-save', 'hq-creative-design-status', 'hq-creative-design-photo']);
});

it('maps HQ refusals and denials the same way as the school editor', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'CREATIVE_DESIGN_NAME_TAKEN' }, { status: 409 })));
  await expect(HQ_DESIGNS_API.setStatus(HQ_DESIGNS_SCOPE, { designId: id('d'), expectedVersion: 1, status: 'ARCHIVED' }, id('9'))).rejects.toBeInstanceOf(DesignsRefusal);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'SAAS_FORBIDDEN' }, { status: 403 })));
  await expect(HQ_DESIGNS_API.list(HQ_DESIGNS_SCOPE, {})).rejects.toBeInstanceOf(DesignsAccessError);
});

it('shows HQ words (no school), uses the HON brand kit, and every HQ word exists in en, ko and es', async () => {
  const html = renderToStaticMarkup(<HqDesigns/>);
  expect(html).toContain('Designs for HON'); expect(html).toContain('Nothing here costs anything or uses AI');
  expect(html).not.toContain('Choose a school first'); expect(html).not.toContain('for your school');
  expect(await HQ_DESIGNS_API.brand!(HQ_DESIGNS_SCOPE, new AbortController().signal, () => true)).toEqual(HQ_BRAND);
  for (const lang of ['en', 'ko', 'es']) for (const key of Object.values(HQ_DESIGN_WORDS) as DesignKey[]) expect(designText(lang, key)).not.toBe('');
  expect(designText('ko', 'hqTitle')).not.toBe(designText('en', 'hqTitle'));
});
