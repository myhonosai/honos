import * as SecureStore from 'expo-secure-store';

const KEY = 'hon.parent.session';
const MAX_TOKEN = 4096;

/**
 * The only thing the app persists about the signed-in parent is the signed HON session itself, kept in the
 * platform keychain/keystore and never synced to other devices. Family, school and child scope are never stored:
 * they are re-resolved by the server on every read.
 */
export function createSessionStore() {
  const listeners = new Set<(token: string | null) => void>();
  let cached: string | null | undefined;
  const emit = (t: string | null) => { for (const l of listeners) l(t); };
  return {
    async token(): Promise<string | null> {
      if (cached === undefined) cached = await SecureStore.getItemAsync(KEY);
      return cached;
    },
    async save(token: string): Promise<void> {
      if (!token || token.length > MAX_TOKEN) throw new Error('Refusing to store an invalid session.');
      await SecureStore.setItemAsync(KEY, token, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
      cached = token; emit(token);
    },
    async clear(): Promise<void> {
      cached = null;
      await SecureStore.deleteItemAsync(KEY);
      emit(null);
    },
    subscribe(listener: (token: string | null) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
export type SessionStore = ReturnType<typeof createSessionStore>;
