import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ParentApp } from '../src/ParentApp';
import { createParentApi, type ParentApi } from '../src/api/client';
import { createSampleApi } from '../src/sample/sample-api';
import { verifyParentSchoolAnnouncements } from '@hon/contracts/school-announcements';
import { NOW } from './fixtures';

const signedOut = { token: async () => null, clear: async () => {}, subscribe: () => () => {} };
const now = () => new Date(NOW);
let n = 0;
const newKey = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const liveApi = createParentApi({ baseUrl: 'https://api.example.test', getToken: async () => null, fetchImpl: jest.fn() });
const id = (i: number) => `77777777-7777-4777-8777-${String(i).padStart(12, '0')}`;

async function openHome(api: ParentApi) {
  await render(<ParentApp api={liveApi} session={signedOut} now={now} newKey={newKey} sampleApi={() => api} />);
  await fireEvent.press(await screen.findByRole('button', { name: 'Try with a sample family' }));
  await screen.findByRole('button', { name: 'Open Mia Sample journey' });
}

describe('school announcements on Home', () => {
  it('shows the sample school announcements newest first', async () => {
    await openHome(createSampleApi(now));
    expect(await screen.findByText('Announcements')).toBeTruthy();
    const first = screen.getByText('Belt testing next Saturday'), second = screen.getByText('Closed Monday for the holiday');
    expect(first).toBeTruthy(); expect(second).toBeTruthy();
  });

  it('shows three, then all on request, and opens one to read it in full', async () => {
    const list = Array.from({ length: 5 }, (_, i) => ({ announcementId: id(i), title: `Note ${i + 1}`, body: `Body ${i + 1}`,
      publishedAt: new Date(Date.parse(NOW) - (i + 1) * 3_600_000).toISOString() }));
    const api = { ...createSampleApi(now), announcements: async () => ({ ok: true as const, data: verifyParentSchoolAnnouncements({ schoolName: 'Dojo', announcements: list }) }) } as ParentApi;
    await openHome(api);
    expect(await screen.findByText('Note 1')).toBeTruthy();
    expect(screen.getByText('Note 3')).toBeTruthy();
    expect(screen.queryByText('Note 4')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Show all 5 announcements' }));
    expect(screen.getByText('Note 5')).toBeTruthy();
    const card = screen.getByRole('button', { name: /Announcement, .*: Note 1/ });
    expect(card.props.accessibilityState).toMatchObject({ expanded: false });
    await fireEvent.press(card);
    expect(screen.getByRole('button', { name: /Announcement, .*: Note 1/ }).props.accessibilityState).toMatchObject({ expanded: true });
  });

  it('shows no section when nothing is posted or the read fails', async () => {
    const empty = { ...createSampleApi(now), announcements: async () => ({ ok: true as const, data: verifyParentSchoolAnnouncements({ schoolName: 'Dojo', announcements: [] }) }) } as ParentApi;
    await openHome(empty);
    await screen.findByText('Next class');
    expect(screen.queryByText('Announcements')).toBeNull();
  });

  it('a failed read shows nothing rather than a guess', async () => {
    const failing = { ...createSampleApi(now), announcements: async () => ({ ok: false as const, state: 'unavailable' as const }) } as ParentApi;
    await openHome(failing);
    await screen.findByText('Next class');
    expect(screen.queryByText('Announcements')).toBeNull();
  });
});
