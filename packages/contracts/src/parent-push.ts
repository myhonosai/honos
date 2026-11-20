/**
 * Parent announcement push (0601). A family member signed in to the HON Family app registers the phone's Expo push token;
 * when staff post an announcement (0576) the communication worker sends one notification per live phone at the school:
 * the school's name and the announcement title, nothing else. Off unless the API is configured to send
 * (HON_PARENT_PUSH_APPROVED). A send with no answer is UNKNOWN and is never sent again.
 */
export const PARENT_PUSH_PLATFORMS = ['ios', 'android'] as const;
export type ParentPushPlatform = (typeof PARENT_PUSH_PLATFORMS)[number];
export const PARENT_PUSH_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,100}\]$/;

export interface RegisterParentPushDeviceInput { expoPushToken: string; platform: ParentPushPlatform }
export interface UnregisterParentPushDeviceInput { expoPushToken: string }
export interface ParentPushDeviceReceipt { device: { deviceId: string; platform: ParentPushPlatform }; replayed: boolean }
export interface ParentPushUnregisterReceipt { unregistered: boolean }
/** What the notification carries, in data: never a name, a body or a family. */
export interface ParentPushData { type: 'school_announcement'; announcementId: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function invalid(): never { throw new Error('Invalid parent push data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}
export function isParentPushToken(value: unknown): value is string { return typeof value === 'string' && PARENT_PUSH_TOKEN.test(value); }

export function validateRegisterParentPushDeviceInput(value: unknown): RegisterParentPushDeviceInput {
  const row = record(value, ['expoPushToken', 'platform']);
  if (!isParentPushToken(row.expoPushToken) || !PARENT_PUSH_PLATFORMS.includes(row.platform as ParentPushPlatform)) invalid();
  return { expoPushToken: row.expoPushToken, platform: row.platform as ParentPushPlatform };
}
export function validateUnregisterParentPushDeviceInput(value: unknown): UnregisterParentPushDeviceInput {
  const row = record(value, ['expoPushToken']);
  if (!isParentPushToken(row.expoPushToken)) invalid();
  return { expoPushToken: row.expoPushToken };
}
export function verifyParentPushDeviceReceipt(value: unknown, platform?: ParentPushPlatform): ParentPushDeviceReceipt {
  const row = record(value, ['device', 'replayed']);
  const device = record(row.device, ['deviceId', 'platform']);
  if (typeof device.deviceId !== 'string' || !UUID.test(device.deviceId) || !PARENT_PUSH_PLATFORMS.includes(device.platform as ParentPushPlatform)
    || (platform && device.platform !== platform) || typeof row.replayed !== 'boolean') invalid();
  return { device: { deviceId: device.deviceId, platform: device.platform as ParentPushPlatform }, replayed: row.replayed };
}
export function verifyParentPushUnregisterReceipt(value: unknown): ParentPushUnregisterReceipt {
  const row = record(value, ['unregistered']);
  if (typeof row.unregistered !== 'boolean') invalid();
  return { unregistered: row.unregistered };
}
/** The app accepts a notification tap only in this exact shape. */
export function readParentPushData(value: unknown): ParentPushData | null {
  try {
    const row = record(value, ['type', 'announcementId']);
    if (row.type !== 'school_announcement' || typeof row.announcementId !== 'string' || !UUID.test(row.announcementId)) return null;
    return { type: 'school_announcement', announcementId: row.announcementId };
  } catch { return null; }
}
