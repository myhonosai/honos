import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CREATIVE_DESIGN_SIZE_CODES, DESIGN_DRAFT_COMMAND, DESIGN_DRAFT_STYLES, DESIGN_DRAFT_THEMES, DESIGN_DRAFT_WORDS, validateCreativeDesignDocument, type DesignDraftOption, type DesignDraftView,
} from '@hon/contracts';

vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ preferences: { language: 'en' } }) }));
vi.mock('../src/components/school-shell/context', () => ({
  useSchoolShell: () => ({ phase: 'READY', selection: { organizationId: '11111111-1111-4111-8111-111111111111', schoolId: '22222222-2222-4222-8222-222222222222' } }),
}));

import { TEMPLATE_STYLES, TEMPLATE_THEMES, templateDocument, type TemplateId } from '../src/components/design-editor/templates';
import { DesignAiBox, draftChoices, draftNoticeKey } from '../src/components/design-editor/ai-draft';
import { DesignDraftError, designDraftApi, draftLanguage } from '../src/components/design-editor/draft-http';
import { DESIGNS_API, createInput } from '../src/components/design-editor/designs';
import { HQ_DESIGNS_API } from '../src/components/hq-creative/hq-designs';
import { designText, type DesignKey } from '../src/components/design-editor/copy';

const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const scope = { organizationId: id('1'), schoolId: id('2') };
const url = `/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/creative-studio/design-drafts`;
const words = { kicker: 'AGES 5 TO 12', head: 'SUMMER\nCAMP', sub: 'July 7 to 11 · $199 a week', details: 'Martial arts · Games · Friends', cta: 'Sign up by June 20' };
const option = (style: DesignDraftOption['style'], over: Partial<DesignDraftOption> = {}): DesignDraftOption => ({ theme: 'camp', style, words, schedule: null, ...over });
const brief = { brief: 'Summer camp, kids 5 to 12', size: 'FLYER_LETTER' as const, language: 'en' as const };
const view = (over: Partial<DesignDraftView> = {}): DesignDraftView => ({ id: id('a'), status: 'RESULT_RECORDED', reason: null, brief, mine: true,
  draft: { options: [option('bold'), option('fun'), option('elegant')] }, problems: [], createdAt: '2026-11-28T00:00:00.000Z', updatedAt: '2026-11-28T00:00:00.000Z', ...over });
const t = (key: DesignKey) => designText('en', key);
afterEach(() => vi.unstubAllGlobals());

describe('E4a Describe your design', () => {
  it('the contract offers exactly the E2 themes and looks', () => {
    expect([...DESIGN_DRAFT_THEMES]).toEqual([...TEMPLATE_THEMES]);
    expect([...DESIGN_DRAFT_STYLES]).toEqual([...TEMPLATE_STYLES]);
  });

  it('every option Marcus may send, at every size, with the longest words, builds a design the database accepts', () => {
    const longest = Object.fromEntries(Object.entries(DESIGN_DRAFT_WORDS).map(([k, r]) => [k, k === 'head' ? `${'W'.repeat(19)}\n${'W'.repeat(20)}` : 'W'.repeat(r.max)])) as typeof words;
    const korean = Object.fromEntries(Object.entries(DESIGN_DRAFT_WORDS).map(([k, r]) => [k, k === 'head' ? `${'가'.repeat(19)}\n${'가'.repeat(20)}` : '가'.repeat(r.max)])) as typeof words;
    const rows = Array.from({ length: 6 }, () => ['W'.repeat(30), 'W'.repeat(30), 'W'.repeat(30)] as const);
    for (const code of CREATIVE_DESIGN_SIZE_CODES) for (const theme of DESIGN_DRAFT_THEMES) for (const style of DESIGN_DRAFT_STYLES) for (const w of [words, longest, korean, { ...words, details: '' }]) {
      const doc = templateDocument(`${theme}-${style}` as TemplateId, code, 'en', { accent: null, contactLine: null }, { words: w, schedule: theme === 'schedule' ? rows : null });
      expect(() => validateCreativeDesignDocument(doc, code), `${theme}-${style} ${code}`).not.toThrow();
      const texts = doc.pages[0]!.elements.flatMap(e => e.kind === 'text' ? [e.text] : []);
      expect(texts, `${theme}-${style} ${code}`).toContain(w.head);
      expect(texts).toContain(w.cta);
      if (!w.details) expect(doc.pages[0]!.elements.some(e => e.id === 'details')).toBe(false);
    }
    // A schedule option's own rows replace the starter timetable.
    const sched = templateDocument('schedule-clean', 'FLYER_LETTER', 'en', undefined, { words, schedule: [['Tue', '7 PM', 'Adults']] }).pages[0]!.elements;
    expect(sched.filter(e => e.id.startsWith('day-'))).toHaveLength(1);
    expect(sched.find(e => e.id === 'class-0')).toMatchObject({ text: 'Adults' });
    // Without copy the starter words stay as before.
    expect(templateDocument('camp-bold', 'FLYER_LETTER', 'en').pages[0]!.elements.find(e => e.id === 'head')).toMatchObject({ text: 'SUMMER\nCAMP' });
  });

  it('a recorded draft becomes picks; any other outcome explains itself in plain words', () => {
    const choices = draftChoices(view());
    expect(choices.map(c => c.template)).toEqual(['camp-bold', 'camp-fun', 'camp-elegant']);
    expect(choices[0]).toMatchObject({ key: `${id('a')}:0`, draftId: id('a'), copy: { words, schedule: null } });
    const input = createInput('', 'FLYER_LETTER', choices[1]!.template, 'en', undefined, choices[1]!.copy);
    expect(input).toBeNull();
    const named = createInput('Camp flyer', 'FLYER_LETTER', choices[1]!.template, 'en', undefined, choices[1]!.copy)!;
    expect(named.document.pages[0]!.elements.find(e => e.id === 'cta')).toMatchObject({ text: 'Sign up by June 20' });
    expect(draftChoices(view({ status: 'APPLIED' }))).toEqual([]);
    expect(draftChoices(null)).toEqual([]);
    expect(draftNoticeKey(view())).toBeNull();
    const cases: [DesignDraftView['status'], DesignKey][] = [['CONFIGURATION_REQUIRED', 'aiOff'], ['BLOCKED', 'aiStopped'], ['RESULT_REJECTED', 'aiRejected'], ['FAILED', 'aiFailed'], ['UNKNOWN', 'aiUnknown'], ['SENDING', 'aiUnknown']];
    for (const [status, key] of cases) expect(draftNoticeKey(view({ status, draft: null })), status).toBe(key);
    const errors: [string, DesignKey][] = [['SESSION', 'session'], ['DESIGN_DRAFT_FORBIDDEN', 'aiForbidden'], ['DESIGN_DRAFT_SPEND_STOPPED', 'aiStopped'], ['DESIGN_DRAFT_INVALID', 'aiInvalid'],
      ['DESIGN_DRAFT_CONFLICT', 'aiBusy'], ['DESIGN_DRAFT_PERSISTENCE_UNKNOWN', 'aiUnknown'], ['DESIGN_DRAFT_UNAVAILABLE', 'aiFailed']];
    for (const [code, key] of errors) expect(draftNoticeKey(new DesignDraftError(code)), code).toBe(key);
    for (const language of ['en', 'ko', 'es']) for (const key of ['aiTitle', 'aiAsk', 'aiOff', 'aiForbidden', 'aiRejected', 'aiUnknown', 'checkOffers'] as const) expect(designText(language, key).length).toBeGreaterThan(3);
    expect(designText('ko', 'aiAsk')).not.toBe(designText('en', 'aiAsk'));
  });

  it('asks the same-origin school route with its own command and a key, and sends only the brief, size and language', async () => {
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init: RequestInit) => { calls.push([u, init]);
      return Response.json({ data: init.method === 'GET' ? { aiAvailable: true, requests: [] } : view(), meta: {} }, { status: 200 }); }));
    expect(await designDraftApi.available(scope)).toBe(true);
    const got = await designDraftApi.draft(scope, brief.brief, 'FLYER_LETTER', 'en', id('c'));
    expect(got.draft?.options).toHaveLength(3);
    await designDraftApi.close(scope, id('a'), 'APPLIED', id('d'));
    expect(calls.map(([u, i]) => [u, i.method])).toEqual([[url, 'GET'], [url, 'POST'], [`${url}/${id('a')}/close`, 'POST']]);
    for (const [, init] of calls) {
      const h = init.headers as Record<string, string>;
      expect(h['X-Hon-Human-Command']).toBe(DESIGN_DRAFT_COMMAND);
      expect([init.credentials, init.mode, init.redirect]).toEqual(['same-origin', 'same-origin', 'error']);
    }
    expect(JSON.parse(String(calls[1]![1].body))).toEqual(brief);
    expect((calls[1]![1].headers as Record<string, string>)['Idempotency-Key']).toBe(id('c'));
    // A brief the server would refuse is never sent; a refusal comes back as its code.
    await expect(designDraftApi.draft(scope, 'x'.repeat(601), 'FLYER_LETTER', 'en', id('c'))).rejects.toMatchObject({ code: 'DESIGN_DRAFT_INVALID' });
    expect(calls).toHaveLength(3);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'DESIGN_DRAFT_SPEND_STOPPED' }, { status: 403 })));
    await expect(designDraftApi.draft(scope, brief.brief, 'FLYER_LETTER', 'en', id('c'))).rejects.toMatchObject({ code: 'DESIGN_DRAFT_SPEND_STOPPED' });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'SOMETHING_ELSE' }, { status: 403 })));
    await expect(designDraftApi.draft(scope, brief.brief, 'FLYER_LETTER', 'en', id('c'))).rejects.toMatchObject({ code: 'DESIGN_DRAFT_FORBIDDEN' });
    // An answer that is not a closed draft view is not shown.
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: { ...view(), draft: { options: [{ ...option('bold'), theme: 'wedding' }] } } }, { status: 200 })));
    await expect(designDraftApi.draft(scope, brief.brief, 'FLYER_LETTER', 'en', id('c'))).rejects.toMatchObject({ code: 'DESIGN_DRAFT_UNAVAILABLE' });
    // Any failure to read availability reads as off.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await designDraftApi.available(scope)).toBe(false);
    expect([draftLanguage('ko-KR'), draftLanguage('es'), draftLanguage('fr'), draftLanguage('en-US')]).toEqual(['ko', 'es', 'en', 'en']);
  });

  it('shows a waiting box until the server says AI is on; schools get it, HQ does not', () => {
    const api = { available: vi.fn(() => new Promise<boolean>(() => {})), draft: vi.fn(), close: vi.fn() };
    const html = renderToStaticMarkup(<DesignAiBox api={api} scope={scope} code="FLYER_LETTER" language="en" brand={{ accent: null, contactLine: null }} value={null} onPick={() => {}} t={t} />);
    expect(html).toContain('Describe your design');
    expect(html).toContain('maxLength="600"');
    expect(html).toMatch(/<textarea[^>]*disabled/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Ask Marcus</);
    expect(api.draft).not.toHaveBeenCalled();
    expect(DESIGNS_API.ai).toBe(designDraftApi);
    expect(HQ_DESIGNS_API.ai).toBeUndefined();
  });
});
