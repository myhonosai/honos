import * as SecureStore from 'expo-secure-store';
import { createSessionStore } from '../src/session/session-store';

jest.mock('expo-secure-store', () => {
  const data = new Map<string, string>();
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WUTDO',
    getItemAsync: jest.fn(async (k: string) => data.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => { data.set(k, v); }),
    deleteItemAsync: jest.fn(async (k: string) => { data.delete(k); }),
  };
});

describe('session store', () => {
  it('keeps the session in the device keychain, on this device only, and clears it on sign-out', async () => {
    const store = createSessionStore();
    expect(await store.token()).toBeNull();
    await store.save('signed-token');
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('hon.parent.session', 'signed-token', { keychainAccessible: 'WUTDO' });
    expect(await store.token()).toBe('signed-token');
    await store.clear();
    expect(await store.token()).toBeNull();
  });

  it('notifies listeners when the session is cleared so screens drop family data', async () => {
    const store = createSessionStore();
    const seen: Array<string | null> = [];
    store.subscribe(t => seen.push(t));
    await store.save('a');
    await store.clear();
    expect(seen).toEqual(['a', null]);
  });

  it('refuses to save an empty or oversized token', async () => {
    const store = createSessionStore();
    await expect(store.save('')).rejects.toThrow();
    await expect(store.save('x'.repeat(5000))).rejects.toThrow();
  });
});
