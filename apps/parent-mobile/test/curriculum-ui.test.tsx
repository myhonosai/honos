import React from 'react';
import * as WebBrowser from 'expo-web-browser';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ParentApp } from '../src/ParentApp';
import { createParentApi, type ParentApi } from '../src/api/client';
import { createSampleApi } from '../src/sample/sample-api';
import { verifyParentCurriculumApp } from '@hon/contracts/parent-app-curriculum';
import { formatCurriculumDate, nextLine, nowLine, sectionTitle } from '../src/more/curriculum-model';
import { NOW } from './fixtures';

// 0610 More > Curriculum: per child, the current rank or cycle and the school's material for it. Names and links only.
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'opened' })) }));
const signedOut = { token: async () => null, clear: async () => {}, subscribe: () => () => {} };
const now = () => new Date(NOW);
let n = 0;
const newKey = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const liveApi = createParentApi({ baseUrl: 'https://api.example.test', getToken: async () => null, fetchImpl: jest.fn() });
const item = (title: string, kind = 'VIDEO', url = 'https://www.myhonos.com/watch') => ({ title, description: `About ${title}`, kind, url });
const rankEntry = (patch: Record<string, unknown> = {}) => ({ curriculumName: 'Kids Program', mode: 'RANK', rank: { name: 'Yellow Belt', color: '#FFD400' }, cycle: null,
  next: { name: 'Orange Belt', startsOn: null }, sections: [{ label: 'CURRENT', items: [item('Yellow form'), item('Yellow checklist', 'DOCUMENT')] },
    { label: 'REVIEW', items: [item('White form')] }, { label: 'NEXT', items: [item('Orange preview')] }, { label: 'ALL', items: [item('Dojo etiquette', 'LINK')] }], ...patch });
const cycleEntry = (patch: Record<string, unknown> = {}) => ({ curriculumName: 'Adult Cycle', mode: 'CYCLE', rank: null,
  cycle: { name: 'Cycle 2: Kicks', startsOn: '2026-11-23', endsOn: '2026-11-29', rotation: 'AUTO' }, next: { name: 'Cycle 3: Forms', startsOn: '2026-11-30' },
  sections: [{ label: 'CURRENT', items: [item('Kicks video')] }], ...patch });
const view = (children: unknown[]) => verifyParentCurriculumApp({ children });

async function openCurriculum(api: ParentApi) {
  await render(<ParentApp api={liveApi} session={signedOut} now={now} newKey={newKey} sampleApi={() => api} />);
  await fireEvent.press(await screen.findByRole('button', { name: 'Try with a sample family' }));
  await screen.findByRole('button', { name: 'Open Mia Sample journey' });
  await fireEvent.press(screen.getByRole('tab', { name: 'More' }));
  await fireEvent.press(await screen.findByRole('button', { name: 'Open Curriculum' }));
}
const withRead = (data: ReturnType<typeof view>) => ({ ...createSampleApi(now), sampleMode: false, curriculumApp: async () => ({ ok: true as const, data }) } as ParentApi);

describe('curriculum screen', () => {
  it('rank-based: the current rank, the next rank and each section in plain words', async () => {
    await openCurriculum(withRead(view([{ childDisplayName: 'Mia Sample', curricula: [rankEntry()] }])));
    expect(await screen.findByText('Current rank: Yellow Belt')).toBeTruthy();
    expect(screen.getByText('Next rank: Orange Belt')).toBeTruthy();
    for (const title of ['For this rank', 'Earlier ranks to review', 'Coming next rank', 'For everyone']) expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText('DOCUMENT')).toBeTruthy();
    expect(screen.getByText('Open document')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Open Yellow form' }));
    expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://www.myhonos.com/watch');
  });

  it('cycle-based: the cycle taught now with its dates and the next cycle; children are named when there are several', async () => {
    await openCurriculum(withRead(view([{ childDisplayName: 'Leo Sample', curricula: [cycleEntry()] }, { childDisplayName: 'Mia Sample', curricula: [rankEntry()] }])));
    expect(await screen.findByText('Now: Cycle 2: Kicks, through Nov 29')).toBeTruthy();
    expect(screen.getByText('Next: Cycle 3: Forms, starts Nov 30')).toBeTruthy();
    expect(screen.getByText('This cycle')).toBeTruthy();
    expect(screen.getByText('Leo Sample')).toBeTruthy();
    expect(screen.getByText('Mia Sample')).toBeTruthy();
  });

  it('a long section shows five items until the family asks for all', async () => {
    const many = Array.from({ length: 12 }, (_, i) => item(`Drill ${String(i + 1).padStart(2, '0')}`));
    await openCurriculum(withRead(view([{ childDisplayName: 'Mia Sample', curricula: [rankEntry({ sections: [{ label: 'CURRENT', items: many }] })] }])));
    expect(await screen.findByText('Drill 05')).toBeTruthy();
    expect(screen.queryByText('Drill 06')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Show all 12 in For this rank' }));
    expect(screen.getByText('Drill 12')).toBeTruthy();
  });

  it('says so when the school has shared nothing', async () => {
    await openCurriculum(withRead(view([{ childDisplayName: 'Mia Sample', curricula: [] }])));
    expect(await screen.findByText('Your school has not shared a curriculum in the app yet.')).toBeTruthy();
  });

  it('says so when a cycle is not picked and no material is shared', async () => {
    await openCurriculum(withRead(view([{ childDisplayName: 'Leo Sample', curricula: [cycleEntry({ cycle: null, next: null, sections: [] })] }])));
    expect(await screen.findByText('Your school has not picked the current cycle yet')).toBeTruthy();
    expect(screen.getByText('Your school has not shared videos or documents for this yet.')).toBeTruthy();
  });

  it('a failed read shows nothing old and can be tried again', async () => {
    let calls = 0;
    const api = { ...createSampleApi(now), sampleMode: false, curriculumApp: async () => (++calls === 1 ? { ok: false as const, state: 'unavailable' as const } : { ok: true as const, data: view([{ childDisplayName: 'Mia Sample', curricula: [rankEntry()] }]) }) } as ParentApi;
    await openCurriculum(api);
    expect(await screen.findByText('The curriculum is unavailable')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Current rank: Yellow Belt')).toBeTruthy();
  });

  it('the sample family opens the same screen with invented material', async () => {
    await openCurriculum(createSampleApi(now));
    expect(await screen.findByText('Form 1 walkthrough')).toBeTruthy();
    expect(screen.getByText(/^Now: Cycle 2: Kicks, through /)).toBeTruthy();
  });
});

describe('curriculum wording', () => {
  it('words only what HON returned', () => {
    expect(formatCurriculumDate('2026-03-01')).toBe('Mar 1');
    expect(nowLine({ mode: 'RANK', rank: null, cycle: null })).toBe('No rank yet');
    expect(nowLine({ mode: 'CYCLE', rank: null, cycle: { name: 'Cycle 1', startsOn: '2026-11-20', endsOn: null, rotation: 'STAFF_PICK' } })).toBe('Now: Cycle 1');
    expect(nextLine({ mode: 'CYCLE', next: { name: 'Cycle 2', startsOn: null } })).toBe('Next: Cycle 2');
    expect(nextLine({ mode: 'RANK', next: null })).toBeNull();
    expect(sectionTitle('CYCLE', 'NEXT')).toBe('Next cycle');
  });

  it('the client reads the app curriculum from HON and rejects a response with ids or unsafe links', async () => {
    const body = { children: [{ childDisplayName: 'Mia Sample', curricula: [rankEntry()] }] };
    const respond = (data: unknown) => jest.fn(async () => new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const good = respond(body);
    const read = await createParentApi({ baseUrl: 'https://api.example.test', getToken: async () => 'token', fetchImpl: good }).curriculumApp();
    expect(read.ok && read.data.children[0]!.curricula[0]!.rank!.name).toBe('Yellow Belt');
    expect(String((good.mock.calls[0] as unknown[])[0])).toBe('https://api.example.test/v1/parent/curriculum-app');
    for (const bad of [{ children: [{ childDisplayName: 'Mia', id: 'x', curricula: [] }] },
      { children: [{ childDisplayName: 'Mia', curricula: [rankEntry({ sections: [{ label: 'CURRENT', items: [item('x', 'VIDEO', 'http://www.myhonos.com/watch')] }] })] }] }]) {
      const out = await createParentApi({ baseUrl: 'https://api.example.test', getToken: async () => 'token', fetchImpl: respond(bad) }).curriculumApp();
      expect(out.ok).toBe(false);
    }
  });
});
