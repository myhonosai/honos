/**
 * Which HON conversation is open, remembered for this browser tab so the corner pop-up and the
 * full `/staff/hon` workspace show the same conversation (owner request 2026-11-19).
 *
 * Only a conversation id is kept, per school, in sessionStorage. It is a selector, never authority:
 * the conversation is reopened only when the server's requester-scoped list still contains it, and
 * the session end forgets every remembered id. Nothing typed is stored.
 */
import type { HonSchool } from './hon-conversation-http';

const PREFIX = 'hon.conversation.open:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tabStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; }
}
function keyFor(school: HonSchool): string | null {
  return UUID.test(school.organizationId) && UUID.test(school.schoolId) ? `${PREFIX}${school.organizationId.toLowerCase()}/${school.schoolId.toLowerCase()}` : null;
}

export function rememberedConversation(school: HonSchool, storage: Storage | null = tabStorage()): string | null {
  const key = keyFor(school);
  if (!key || !storage) return null;
  try { const value = storage.getItem(key); return value && UUID.test(value) ? value.toLowerCase() : null; } catch { return null; }
}

export function rememberConversation(school: HonSchool, conversationId: string | null, storage: Storage | null = tabStorage()): void {
  const key = keyFor(school);
  if (!key || !storage) return;
  try {
    if (conversationId && UUID.test(conversationId)) storage.setItem(key, conversationId.toLowerCase());
    else storage.removeItem(key);
  } catch { /* storage unavailable: the pop-up and workspace simply start without an open conversation */ }
}

export function forgetHonConversations(storage: Storage | null = tabStorage()): void {
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (key?.startsWith(PREFIX)) keys.push(key); }
    for (const key of keys) storage.removeItem(key);
  } catch { /* nothing to forget */ }
}
