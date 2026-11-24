import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ParentApp } from '../src/ParentApp';
import { createParentApi } from '../src/api/client';
import { createSampleApi } from '../src/sample/sample-api';
import { NOW } from './fixtures';

const signedOut = { token: async () => null, clear: async () => {}, subscribe: () => () => {} };
const now = () => new Date(NOW);
let n = 0;
const newKey = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const liveApi = createParentApi({ baseUrl: 'https://api.example.test', getToken: async () => null, fetchImpl: jest.fn() });

async function openSample() {
  await render(<ParentApp api={liveApi} session={signedOut} now={now} newKey={newKey} sampleApi={() => createSampleApi(now)} />);
  await fireEvent.press(await screen.findByRole('button', { name: 'Try with a sample family' }));
  await screen.findByRole('button', { name: 'Open Mia Sample journey' });
}

describe('sample family (test builds)', () => {
  it('is not offered unless the build enables it', async () => {
    await render(<ParentApp api={liveApi} session={signedOut} now={now} newKey={newKey} />);
    await screen.findByText('Sign in to your school');
    expect(screen.queryByRole('button', { name: 'Try with a sample family' })).toBeNull();
  });

  it('shows a SAMPLE banner on every tab and exits back to sign-in', async () => {
    await openSample();
    for (const tab of ['Schedule', 'Eian', 'Messages', 'More']) {
      await fireEvent.press(screen.getByRole('tab', { name: tab }));
      expect(screen.getByText(/SAMPLE FAMILY/)).toBeTruthy();
    }
    await fireEvent.press(screen.getByRole('button', { name: 'Exit sample' }));
    expect(await screen.findByText('Sign in to your school')).toBeTruthy();
  });

  it('Eian answers from the records and offers the normal screen for actions', async () => {
    await openSample();
    await fireEvent.press(screen.getByRole('tab', { name: 'Eian' }));
    expect(await screen.findByText(/next class is/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Invoices' }));
    expect(await screen.findByText('You have 1 open invoice:')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Ask Eian: Report an absence' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Report an absence' }));
    expect(await screen.findByText('Classes')).toBeTruthy();
  });

  it('More opens billing, passes, testing and the library from verified reads', async () => {
    await openSample();
    await fireEvent.press(screen.getByRole('tab', { name: 'More' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Open Membership & billing' }));
    expect((await screen.findAllByText('$149.00')).length).toBe(2);
    expect(screen.getByText('Open')).toBeTruthy();
    expect(screen.getAllByText('Paid').length).toBe(2);
    await fireEvent.press(screen.getByRole('button', { name: 'Back to More' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Open Class passes' }));
    expect(await screen.findByText('7 uses left')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Back to More' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Open Belt testing' }));
    expect(await screen.findByText(/Next test: Kids belt test/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Back to More' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Open Curriculum' }));
    expect(await screen.findByText('Form 1 walkthrough')).toBeTruthy();
  });

  it('More shows an honest unavailable state when a read fails', async () => {
    const api = { ...createSampleApi(now), billing: async () => ({ ok: false as const, state: 'unavailable' as const }) };
    await render(<ParentApp api={liveApi} session={signedOut} now={now} newKey={newKey} sampleApi={() => api} />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Try with a sample family' }));
    await screen.findByRole('button', { name: 'Open Mia Sample journey' });
    await fireEvent.press(screen.getByRole('tab', { name: 'More' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Open Membership & billing' }));
    expect(await screen.findByText('Billing is unavailable')).toBeTruthy();
  });
});
