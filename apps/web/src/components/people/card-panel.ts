import { CARD_TABS, type CardTab } from './contact-card';

/** How the open contact card sits on the People page: docked beside the list, or over it. Remembered in this browser only. */
export type CardMode = 'SIDE' | 'FULL';
export const CARD_MODE_KEY = 'hon.people.cardMode';
type ModeStorage = Pick<Storage, 'getItem' | 'setItem'>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The browser's storage, or null where it is blocked (private windows, previews): the panel then simply opens at the side. */
export function browserStorage(): ModeStorage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}
export function readCardMode(storage: ModeStorage | null = browserStorage()): CardMode {
  try { return storage?.getItem(CARD_MODE_KEY) === 'FULL' ? 'FULL' : 'SIDE'; } catch { return 'SIDE'; }
}
export function writeCardMode(mode: CardMode, storage: ModeStorage | null = browserStorage()): void {
  try { storage?.setItem(CARD_MODE_KEY, mode); } catch { /* a blocked store only means the choice is not remembered */ }
}

/**
 * The address for the People page with this card open (or none), keeping any other parameters. The person id only says
 * which card to read; the server decides who may see it.
 */
export function cardUrl(pathname: string, search: string, target: { personId: string; tab: CardTab } | null): string {
  const params = new URLSearchParams(search);
  params.delete('person'); params.delete('tab');
  if (target) {
    if (!UUID.test(target.personId) || !(CARD_TABS as readonly string[]).includes(target.tab)) throw new Error('A card address needs a person id and a known tab.');
    params.set('person', target.personId.toLowerCase()); params.set('tab', target.tab);
  }
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}
