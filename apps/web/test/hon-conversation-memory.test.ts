import { describe, expect, it } from 'vitest';
import { forgetHonConversations, rememberConversation, rememberedConversation } from '../src/components/hon-command/hon-conversation-memory';

const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const SCHOOL = { organizationId: id(1), schoolId: id(2) }, OTHER = { organizationId: id(1), schoolId: id(3) };
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; }, clear: () => map.clear(), key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, String(v)); }, removeItem: (k: string) => { map.delete(k); },
  };
}

describe('HON open conversation memory (pop-up and full workspace share it)', () => {
  it('remembers the open conversation per school, so the full workspace reopens what the pop-up showed', () => {
    const storage = fakeStorage();
    expect(rememberedConversation(SCHOOL, storage)).toBeNull();
    rememberConversation(SCHOOL, id(5).toUpperCase(), storage);
    expect(rememberedConversation(SCHOOL, storage)).toBe(id(5));
    expect(rememberedConversation(OTHER, storage)).toBeNull();
    rememberConversation(SCHOOL, null, storage);
    expect(rememberedConversation(SCHOOL, storage)).toBeNull();
  });
  it('stores only a conversation id, never anything else, and ignores tampered values', () => {
    const storage = fakeStorage();
    rememberConversation(SCHOOL, 'not-a-uuid', storage);
    expect(storage.length).toBe(0);
    rememberConversation(SCHOOL, id(5), storage);
    expect(storage.getItem(storage.key(0)!)).toBe(id(5));
    storage.setItem(storage.key(0)!, '../hq');
    expect(rememberedConversation(SCHOOL, storage)).toBeNull();
    expect(rememberedConversation({ organizationId: 'x', schoolId: id(2) }, storage)).toBeNull();
  });
  it('forgets every remembered conversation (session end) and leaves other keys alone', () => {
    const storage = fakeStorage();
    storage.setItem('unrelated', 'keep');
    rememberConversation(SCHOOL, id(5), storage); rememberConversation(OTHER, id(6), storage);
    forgetHonConversations(storage);
    expect(rememberedConversation(SCHOOL, storage)).toBeNull();
    expect(rememberedConversation(OTHER, storage)).toBeNull();
    expect(storage.getItem('unrelated')).toBe('keep');
  });
  it('works without storage (server render, private mode or blocked storage)', () => {
    const throwing = { ...fakeStorage(), getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } as Storage;
    expect(rememberedConversation(SCHOOL, throwing)).toBeNull();
    expect(() => rememberConversation(SCHOOL, id(5), throwing)).not.toThrow();
    expect(rememberedConversation(SCHOOL, null)).toBeNull();
    expect(() => forgetHonConversations(null)).not.toThrow();
  });
});
