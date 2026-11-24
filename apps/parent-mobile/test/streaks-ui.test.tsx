import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ParentApp } from '../src/ParentApp';
import { createParentApi, type ParentApi } from '../src/api/client';
import { createSampleApi } from '../src/sample/sample-api';
import { streakLabel } from '../src/home/Streaks';
import { verifyParentAttendanceStreaks } from '@hon/contracts/parent-attendance-streaks';
import { NOW } from './fixtures';

const signedOut = { token: async () => null, clear: async () => {}, subscribe: () => () => {} };
const now = () => new Date(NOW);
let n = 0;
const newKey = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const liveApi = createParentApi({ baseUrl: 'https://api.example.test', getToken: async () => null, fetchImpl: jest.fn() });

async function openHome(api: ParentApi) {
  await render(<ParentApp api={liveApi} session={signedOut} now={now} newKey={newKey} sampleApi={() => api} />);
  await fireEvent.press(await screen.findByRole('button', { name: 'Try with a sample family' }));
  await screen.findByRole('button', { name: 'Open Mia Sample journey' });
}

describe('weekly attendance streak on Home (S1, 0602)', () => {
  it('says the streak in words for screen readers', () => {
    expect(streakLabel('Mia', 5)).toBe('Mia: 5 weeks in a row with a class');
    expect(streakLabel('Mia', 1)).toBe('Mia: 1 week in a row with a class');
    expect(streakLabel('Mia', 0)).toBe('Mia: no classes yet this week or last week');
  });

  it('shows each child\'s flame count, and only the picked child after a pick', async () => {
    await openHome(createSampleApi(now));
    expect(await screen.findByLabelText('Mia Sample: 5 weeks in a row with a class')).toBeTruthy();
    expect(screen.getByLabelText('Leo Sample: 2 weeks in a row with a class')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Show Mia Sample' }));
    expect(await screen.findByLabelText('Mia Sample: 5 weeks in a row with a class')).toBeTruthy();
    expect(screen.queryByLabelText('Leo Sample: 2 weeks in a row with a class')).toBeNull();
  });

  it('shows a zero streak as zero, never a guess', async () => {
    const api = { ...createSampleApi(now), attendanceStreaks: async () => ({ ok: true as const, data: verifyParentAttendanceStreaks({ children: [{ name: 'Mia Sample', weeks: 0 }] }) }) } as ParentApi;
    await openHome(api);
    expect(await screen.findByLabelText('Mia Sample: no classes yet this week or last week')).toBeTruthy();
  });

  it('a failed read shows no streak at all', async () => {
    const api = { ...createSampleApi(now), attendanceStreaks: async () => ({ ok: false as const, state: 'unavailable' as const }) } as ParentApi;
    await openHome(api);
    await screen.findByText('Next class');
    expect(screen.queryByText(/in a row/)).toBeNull();
  });
});
