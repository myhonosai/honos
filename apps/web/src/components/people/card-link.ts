import { CARD_TABS, type CardTab } from './contact-card';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A link that opens one person's contact card on the People page. It only says which card to read; the server decides who may see it. */
export function cardLink(personId: string, tab: CardTab = 'membership'): string {
  if (!UUID.test(personId)) throw new Error('A card link needs a person id.');
  return `/staff/people?person=${personId.toLowerCase()}&tab=${tab}`;
}

/** The card a People link asks to open, or null. A malformed id opens nothing; an unknown tab falls back to the overview. */
export function initialCardTarget(search: string): { personId: string; tab: CardTab } | null {
  let params: URLSearchParams;
  try { params = new URLSearchParams(search); } catch { return null; }
  const personId = params.get('person');
  if (!personId || !UUID.test(personId)) return null;
  const tab = params.get('tab');
  return { personId: personId.toLowerCase(), tab: (CARD_TABS as readonly string[]).includes(tab ?? '') ? tab as CardTab : 'overview' };
}
