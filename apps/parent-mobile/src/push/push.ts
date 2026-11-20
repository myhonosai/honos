import type { ParentPushPlatform } from '@hon/contracts/parent-push';
import type { ParentApi } from '../api/client';

/** What the phone can do for announcement notifications. The Expo version lives in expo-push.ts; tests pass a fake. */
export interface PhonePush {
  platform: ParentPushPlatform;
  /** The phone's Expo push token, asking permission first when `ask` is true. Null when not allowed or not available. */
  token(ask: boolean): Promise<string | null>;
  /** Calls back when the person taps an announcement notification. Returns the unsubscribe. */
  onOpenAnnouncement(listener: () => void): () => void;
}

export type PushRegistration = 'registered' | 'not-allowed' | 'not-saved';

/** Signs this phone up for the signed-in family member. Nothing is registered for the sample family. */
export async function registerPhone(api: ParentApi, phone: PhonePush, newKey: () => string): Promise<PushRegistration> {
  let token: string | null;
  try { token = await phone.token(true); } catch { token = null; }
  if (!token) return 'not-allowed';
  try {
    const saved = await api.registerPushDevice(token, phone.platform, newKey());
    return saved.ok ? 'registered' : 'not-saved';
  } catch { return 'not-saved'; }
}

/** Best effort on sign out: tell the school's server to stop, but never hold sign out up for more than a few seconds. */
export async function unregisterPhone(api: ParentApi, phone: PhonePush, newKey: () => string, waitMs = 3000): Promise<void> {
  const attempt = (async () => {
    const token = await phone.token(false);
    if (token) await api.unregisterPushDevice(token, newKey());
  })().catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([attempt, new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]);
  clearTimeout(timer);
}
