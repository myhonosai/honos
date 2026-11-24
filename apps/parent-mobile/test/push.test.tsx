import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { verifyParentJourneyView } from '@hon/contracts/parent-journey-view';
import { ParentApp } from '../src/ParentApp';
import { createParentApi, type ParentApi, type ParentRead } from '../src/api/client';
import { registerPhone, unregisterPhone, type PhonePush } from '../src/push/push';
import { createSampleApi } from '../src/sample/sample-api';
import { journeyBody, NOW } from './fixtures';

// 0601: the phone signs up on sign-in, lets go on sign out, and a tap opens Home with the latest announcements.
const TOKEN = 'ExponentPushToken[abcdefghij1234567890]';
const KEY = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const DEVICE = { device: { deviceId: '11111111-1111-4111-8111-111111111111', platform: 'ios' as const }, replayed: false };

function fakeSession(token: string | null) {
  let current = token;
  const listeners = new Set<(t: string | null) => void>();
  return {
    token: jest.fn(async () => current),
    clear: jest.fn(async () => { current = null; listeners.forEach(l => l(null)); }),
    subscribe: (l: (t: string | null) => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  };
}
function fakePhone(token: string | null = TOKEN) {
  let open: (() => void) | undefined;
  const phone = {
    platform: 'ios' as const,
    token: jest.fn(async (_ask: boolean) => token),
    onOpenAnnouncement: jest.fn((l: () => void) => { open = l; return () => { open = undefined; }; }),
    tap: () => open?.(),
  };
  return phone;
}
function fakeApi(): ParentApi {
  const journey: ParentRead<ReturnType<typeof verifyParentJourneyView>> = { ok: true, data: verifyParentJourneyView(journeyBody()) };
  return {
    journey: jest.fn(async () => journey), schoolTimeZone: jest.fn(async () => 'America/Los_Angeles'),
    classBookings: jest.fn(async () => ({ ok: false, state: 'unavailable' })), announcements: jest.fn(async () => ({ ok: false, state: 'unavailable' })), attendanceStreaks: jest.fn(async () => ({ ok: false, state: 'unavailable' })), journeyRecommendations: jest.fn(async () => ({ ok: false, state: 'unavailable' })),
    pushStatus: jest.fn(async () => ({ ok: true, data: { sending: true } })),
    registerPushDevice: jest.fn(async () => ({ ok: true, data: DEVICE, replayed: false })),
    unregisterPushDevice: jest.fn(async () => ({ ok: true, data: { unregistered: true }, replayed: false })),
  } as unknown as ParentApi;
}
const now = () => new Date(NOW);
const newKey = () => KEY;

describe('Announcement notifications', () => {
  it('the client sends exactly the closed register and unregister commands', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = jest.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const data = url.endsWith('/unregister') ? { unregistered: true } : url.endsWith('/status') ? { sending: false } : DEVICE;
      return { ok: true, status: 200, json: async () => ({ data }) } as unknown as Response;
    });
    const api = createParentApi({ baseUrl: 'https://api.example.test', getToken: async () => 'tok', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await api.registerPushDevice(TOKEN, 'ios', KEY)).ok).toBe(true);
    expect((await api.unregisterPushDevice(TOKEN, KEY)).ok).toBe(true);
    expect(calls[0]!.url).toBe('https://api.example.test/v1/parent/push-devices');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ expoPushToken: TOKEN, platform: 'ios' });
    expect((calls[0]!.init.headers as Record<string, string>)['x-hon-human-command']).toBe('parent.push_device.register');
    expect(calls[1]!.url).toBe('https://api.example.test/v1/parent/push-devices/unregister');
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ expoPushToken: TOKEN });
    expect(() => api.registerPushDevice('not-a-token', 'ios', KEY)).toThrow();
    expect(await api.pushStatus()).toEqual({ ok: true, data: { sending: false } });
    expect(calls[2]!.url).toBe('https://api.example.test/v1/parent/push-devices/status');
    expect(calls[2]!.init.method).toBe('GET');
  });

  it('registers after sign-in, asking permission, and never when signed out', async () => {
    const api = fakeApi(); const phone = fakePhone();
    await render(<ParentApp api={api} session={fakeSession('t')} now={now} newKey={newKey} push={phone} />);
    await waitFor(() => expect(api.registerPushDevice).toHaveBeenCalledWith(TOKEN, 'ios', KEY));
    expect(phone.token).toHaveBeenCalledWith(true);
    const outApi = fakeApi(); const outPhone = fakePhone();
    await render(<ParentApp api={outApi} session={fakeSession(null)} now={now} newKey={newKey} push={outPhone} />);
    await screen.findByText(/Sign in to your school/);
    expect(outPhone.token).not.toHaveBeenCalled();
    expect(outApi.registerPushDevice).not.toHaveBeenCalled();
  });

  it('never asks for permission while the server is not sending', async () => {
    for (const status of [{ ok: true, data: { sending: false } }, { ok: false, state: 'offline' }]) {
      const api = { ...fakeApi(), pushStatus: jest.fn(async () => status) } as unknown as ParentApi;
      const phone = fakePhone();
      expect(await registerPhone(api, phone, newKey)).toBe('not-sending');
      expect(phone.token).not.toHaveBeenCalled();
      expect(api.registerPushDevice).not.toHaveBeenCalled();
    }
  });

  it('does nothing when the person says no to notifications', async () => {
    const api = fakeApi();
    expect(await registerPhone(api, fakePhone(null), newKey)).toBe('not-allowed');
    expect(api.registerPushDevice).not.toHaveBeenCalled();
    const throwing = { ...fakePhone(), token: jest.fn(async () => { throw new Error('no firebase'); }) };
    expect(await registerPhone(api, throwing, newKey)).toBe('not-allowed');
    const refusing = { ...fakeApi(), registerPushDevice: jest.fn(async () => ({ ok: false, state: 'refused' })) } as unknown as ParentApi;
    expect(await registerPhone(refusing, fakePhone(), newKey)).toBe('not-saved');
  });

  it('sign out lets this phone go first, without asking permission, and never waits long', async () => {
    const api = fakeApi(); const phone = fakePhone(); const session = fakeSession('t');
    await render(<ParentApp api={api} session={session} now={now} newKey={newKey} push={phone} />);
    await waitFor(() => expect(api.registerPushDevice).toHaveBeenCalled());
    await fireEvent.press(screen.getByRole('tab', { name: 'More' }));
    await fireEvent.press(await screen.findByRole('button', { name: /Sign out/ }));
    await waitFor(() => expect(session.clear).toHaveBeenCalled());
    expect(api.unregisterPushDevice).toHaveBeenCalledWith(TOKEN, KEY);
    expect(phone.token).toHaveBeenLastCalledWith(false);
    const hanging = { ...fakeApi(), unregisterPushDevice: jest.fn(() => new Promise(() => undefined)) } as unknown as ParentApi;
    const started = Date.now();
    await unregisterPhone(hanging, fakePhone(), newKey, 50);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a tap on an announcement opens Home and reads again', async () => {
    const api = fakeApi(); const phone = fakePhone();
    await render(<ParentApp api={api} session={fakeSession('t')} now={now} newKey={newKey} push={phone} />);
    await screen.findByRole('button', { name: 'Open Test Child A journey' });
    await fireEvent.press(screen.getByRole('tab', { name: 'More' }));
    const reads = (api.journey as jest.Mock).mock.calls.length;
    await act(async () => { phone.tap(); });
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Home' }).props.accessibilityState.selected).toBe(true));
    expect((api.journey as jest.Mock).mock.calls.length).toBeGreaterThan(reads);
  });

  it('the sample family never signs a phone up', async () => {
    const phone = fakePhone();
    const sample = createSampleApi();
    expect((await sample.registerPushDevice(TOKEN, 'ios', KEY)).ok).toBe(false);
    await render(<ParentApp api={fakeApi()} session={fakeSession(null)} now={now} newKey={newKey} push={phone} sampleApi={() => sample} />);
    await fireEvent.press(await screen.findByRole('button', { name: /sample/i }));
    expect(phone.token).not.toHaveBeenCalled();
  });
});
