import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ParentFamilyChoice } from '@hon/contracts';
import { ParentFamilyPicker } from '../src/components/parent-family-picker';
import { chooseParentFamily, loadParentFamilyChoices, ParentFamilyPickerAccessError } from '../src/components/parent-family-picker-http';

// 0471 parent school and family picker web: the list comes from the server, the choice names one listed family, and the
// home page opens nothing else until a parent with several families has chosen.
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333', D = '44444444-4444-4444-8444-444444444444';
const kim: ParentFamilyChoice = { schoolId: A, schoolName: 'Alpha Dojo', familyId: B, familyName: 'Kim Family', accessLevel: 'PRIMARY_GUARDIAN', current: false };
const beta: ParentFamilyChoice = { schoolId: C, schoolName: 'Beta Academy', familyId: D, familyName: 'Kim Family B', accessLevel: 'VIEWER', current: false };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => { vi.restoreAllMocks(); });

describe('parent family picker', () => {
  it('asks a parent with several families to choose, listing each school and family', () => {
    const html = renderToStaticMarkup(<ParentFamilyPicker choices={[kim, beta]} needsChoice busy={false} error={null} onChoose={() => {}} />);
    expect(html).toContain('Which school and family do you want to see?');
    for (const text of ['Alpha Dojo', 'Kim Family', 'Beta Academy', 'Kim Family B', 'Guardian', 'View only', 'without signing out']) expect(html).toContain(text);
    expect(html).not.toContain(A);
  });

  it('shows the current family with a switcher once one is chosen, and nothing for a single family', () => {
    const html = renderToStaticMarkup(<ParentFamilyPicker choices={[{ ...kim, current: true }, beta]} needsChoice={false} busy={false} error={null} onChoose={() => {}} />);
    expect(html).toContain('VIEWING');
    expect(html).toContain('Alpha Dojo · Kim Family');
    expect(html).toContain('<option value="33333333-3333-4333-8333-333333333333/44444444-4444-4444-8444-444444444444">Beta Academy · Kim Family B</option>');
    expect(html).not.toMatch(/<option[^>]*>Alpha Dojo · Kim Family</);
    expect(renderToStaticMarkup(<ParentFamilyPicker choices={[{ ...kim, current: true }]} needsChoice={false} busy={false} error={null} onChoose={() => {}} />)).toBe('');
  });

  it('loads the verified list with a same-origin GET and no selectors', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { data: { choices: [kim, beta], needsChoice: true } }));
    const out = await loadParentFamilyChoices();
    expect(out.needsChoice).toBe(true);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('/api/v1/parent/families');
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' });
    fetcher.mockResolvedValueOnce(json(200, { data: { choices: [{ ...kim, current: true }, { ...beta, current: true }], needsChoice: false } }));
    await expect(loadParentFamilyChoices()).rejects.toThrow('could not be checked');
    fetcher.mockResolvedValueOnce(json(401, { code: 'UNAUTHENTICATED' }));
    await expect(loadParentFamilyChoices()).rejects.toBeInstanceOf(ParentFamilyPickerAccessError);
  });

  it('chooses with the picker command and only accepts an answer where the chosen family is current', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { data: { choices: [kim, { ...beta, current: true }], needsChoice: false } }));
    const out = await chooseParentFamily({ schoolId: C, familyId: D });
    expect(out.choices.find(c => c.current)?.familyId).toBe(D);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('/api/v1/parent/families/current');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'X-HON-Human-Command': 'parent.family.select', 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init?.body))).toEqual({ schoolId: C, familyId: D });
    fetcher.mockResolvedValueOnce(json(200, { data: { choices: [{ ...kim, current: true }, beta], needsChoice: false } }));
    await expect(chooseParentFamily({ schoolId: C, familyId: D })).rejects.toThrow('could not be checked');
    fetcher.mockResolvedValueOnce(json(404, { code: 'PARENT_FAMILY_NOT_AVAILABLE' }));
    await expect(chooseParentFamily({ schoolId: C, familyId: D })).rejects.toThrow('not linked to your account');
    await expect(chooseParentFamily({ schoolId: 'x', familyId: D })).rejects.toThrow();
  });

  it('home lists families first and opens nothing else until a parent with several has chosen', () => {
    const home = readFileSync('src/components/parent-home.tsx', 'utf8');
    expect(home.indexOf('loadParentFamilyChoices(controller.signal)')).toBeLessThan(home.indexOf('loadParentJourney(controller.signal)'));
    expect(home).toContain('if (families?.needsChoice) {');
    expect(home).toContain('!familyAccessLost && !mustChoose && <ParentHomeCards');
    expect(home).toContain("setFamily({ kind: 'hidden' });");
  });
});
