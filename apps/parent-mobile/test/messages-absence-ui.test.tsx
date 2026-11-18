import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { verifyParentJourneyView } from '@hon/contracts/parent-journey-view';
import { verifyParentClassBookingChoices } from '@hon/contracts/parent-class-booking';
import { ParentApp } from '../src/ParentApp';
import type { ParentApi } from '../src/api/client';
import { CHILD_A, NOW, choicesBody, journeyBody } from './fixtures';

const session = { token: async () => 't', clear: async () => {}, subscribe: () => () => {} };
const THREAD = '66666666-6666-4666-8666-666666666666';
const msg = (id: string, o: Record<string, unknown> = {}) => ({ messageId: `77777777-7777-4777-8777-${id.padStart(12, '0')}`, from: 'SCHOOL', mine: false, body: 'Welcome!', sentAt: '2026-11-16T15:00:00.000Z', ...o });
const thread = (messages: unknown[], canWrite = true) => ({ ok: true, data: { canWrite, schoolName: 'Test School', threadId: messages.length ? THREAD : null, messages } });
function fakeApi(overrides: Record<string, jest.Mock>) {
  return {
    journey: jest.fn(async () => ({ ok: true, data: verifyParentJourneyView(journeyBody()) })),
    schoolTimeZone: jest.fn(async () => 'America/Los_Angeles'),
    classBookings: jest.fn(async () => ({ ok: true, data: verifyParentClassBookingChoices(choicesBody().data) })),
    schoolMessages: jest.fn(async () => thread([msg('1')])),
    absenceContext: jest.fn(async () => ({ ok: true, data: { children: [{ studentProfileId: CHILD_A, displayName: 'Test Child A' }] } })),
    ...overrides,
  } as unknown as ParentApi & Record<string, jest.Mock>;
}
let n = 0;
const newKey = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
async function openTab(api: ParentApi, tab: string) {
  await render(<ParentApp api={api} session={session} now={() => new Date(NOW)} newKey={newKey} />);
  await screen.findByRole('button', { name: 'Open Test Child A journey' });
  await fireEvent.press(screen.getByRole('tab', { name: tab }));
}

describe('Messages tab', () => {
  beforeEach(() => { n = 0; });

  it('shows the school conversation and sends a confirmed message', async () => {
    const sent = msg('2', { from: 'FAMILY', mine: true, body: 'See you Tuesday', sentAt: '2026-11-17T15:00:00.000Z' });
    const schoolMessages = jest.fn().mockResolvedValueOnce(thread([msg('1')])).mockResolvedValue(thread([msg('1'), sent]));
    const api = fakeApi({ schoolMessages, sendSchoolMessage: jest.fn(async () => ({ ok: true, replayed: false, data: { threadId: THREAD, version: 3, message: sent } })) });
    await openTab(api, 'Messages');
    expect(await screen.findByText('Welcome!')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Message to your school'), 'See you Tuesday');
    await fireEvent.press(screen.getByRole('button', { name: 'Send message to school' }));
    expect(await screen.findByText('See you Tuesday')).toBeTruthy();
    expect(api.sendSchoolMessage).toHaveBeenCalledWith('See you Tuesday', '00000000-0000-4000-8000-000000000001');
  });

  it('an unknown send is not shown as sent and the retry reuses the same key', async () => {
    const sendSchoolMessage = jest.fn().mockResolvedValueOnce({ ok: false, state: 'unknown' })
      .mockResolvedValueOnce({ ok: true, replayed: true, data: { threadId: THREAD, version: 3, message: msg('2', { from: 'FAMILY', mine: true, body: 'Hi' }) } });
    const api = fakeApi({ sendSchoolMessage });
    await openTab(api, 'Messages');
    await screen.findByText('Welcome!');
    await fireEvent.changeText(screen.getByLabelText('Message to your school'), 'Hi');
    await fireEvent.press(screen.getByRole('button', { name: 'Send message to school' }));
    expect(await screen.findByText(/could not confirm this message was sent/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('button', { name: 'Send message to school' });
    expect(sendSchoolMessage.mock.calls[0][1]).toBe(sendSchoolMessage.mock.calls[1][1]);
  });

  it('read-only family access has no send box', async () => {
    await openTab(fakeApi({ schoolMessages: jest.fn(async () => thread([msg('1')], false)) }), 'Messages');
    expect(await screen.findByText(/read messages but not send/)).toBeTruthy();
    expect(screen.queryByLabelText('Message to your school')).toBeNull();
  });
});

describe('Report an absence', () => {
  beforeEach(() => { n = 0; });

  it('sends a whole school-day request only after the parent picks a child and day', async () => {
    const api = fakeApi({ reportAbsence: jest.fn(async () => ({ ok: true, replayed: false, data: { status: 'SUBMITTED', submittedAt: NOW } })) });
    await openTab(api, 'Schedule');
    await fireEvent.press(await screen.findByRole('button', { name: 'Report an absence' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Send absence to school' }));
    expect(api.reportAbsence).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Test Child A' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Tomorrow' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Send absence to school' }));
    expect(await screen.findByText('Sent to your school')).toBeTruthy();
    expect(api.reportAbsence).toHaveBeenCalledWith({ studentProfileId: CHILD_A, startsAt: '2026-11-18T08:00:00.000Z', endsAt: '2026-11-19T08:00:00.000Z' }, '00000000-0000-4000-8000-000000000001');
  });

  it('an unknown outcome retries the exact same request and key, even after the clock moves', async () => {
    let clock = Date.parse(NOW);
    const reportAbsence = jest.fn().mockResolvedValueOnce({ ok: false, state: 'unknown' })
      .mockResolvedValueOnce({ ok: true, replayed: true, data: { status: 'SUBMITTED', submittedAt: NOW } });
    const api = fakeApi({ reportAbsence });
    await render(<ParentApp api={api} session={session} now={() => new Date(clock)} newKey={newKey} />);
    await screen.findByRole('button', { name: 'Open Test Child A journey' });
    await fireEvent.press(screen.getByRole('tab', { name: 'Schedule' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Report an absence' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Test Child A' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Today' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Send absence to school' }));
    expect(await screen.findByText(/could not confirm this with your school/)).toBeTruthy();
    clock += 2 * 60_000;
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Sent to your school')).toBeTruthy();
    expect(reportAbsence.mock.calls[1]).toEqual(reportAbsence.mock.calls[0]);
    expect(reportAbsence.mock.calls[0][0].startsAt).toBe('2026-11-17T15:01:00.000Z');
  });

  it('a refusal explains why', async () => {
    const api = fakeApi({ reportAbsence: jest.fn(async () => ({ ok: false, state: 'refused', code: 'PARENT_ABSENCE_GUARDIAN_REQUIRED' })) });
    await openTab(api, 'Schedule');
    await fireEvent.press(await screen.findByRole('button', { name: 'Report an absence' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Test Child A' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Today' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Send absence to school' }));
    expect(await screen.findByText(/Only a parent or guardian/)).toBeTruthy();
  });
});
