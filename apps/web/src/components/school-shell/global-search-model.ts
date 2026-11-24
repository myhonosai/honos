import { STAFF_SEARCH_QUERY_MAX, type StaffSearchKind, type StaffSearchResult } from '@hon/contracts';
import type { OperationalSchoolScope } from '../operational-navigation';
import { SCHOOL_SHELL_NAV, SCHOOL_SHELL_SECTIONS, schoolShellHref, schoolShellListed } from './catalog';
import type { ShellIconName } from './icons';
import { shellText, type ShellKey } from './copy';

/**
 * The top-bar search (owner, 2026-11-21: "main search bar on top to search everything from contact to menu").
 * Pages are matched here, in the browser, from the closed menu catalog. Contacts and school records come from the
 * two existing reads, which re-authorize the exact school on the server; this module only shapes and routes them.
 */
export type SearchGroup = 'PAGES' | 'CONTACTS' | 'LEADS' | 'CLASSES' | 'PROGRAMS' | 'CURRICULA';
export const SEARCH_GROUPS: readonly SearchGroup[] = ['CONTACTS', 'LEADS', 'CLASSES', 'PROGRAMS', 'CURRICULA', 'PAGES'];
export const SEARCH_GROUP_TITLE: Record<SearchGroup, ShellKey> = {
  PAGES: 'searchGroupPages', CONTACTS: 'searchGroupContacts', LEADS: 'searchGroupLeads', CLASSES: 'searchGroupClasses',
  PROGRAMS: 'searchGroupPrograms', CURRICULA: 'searchGroupCurricula',
};
export type SearchHit = Readonly<{ group: SearchGroup; key: string; title: string; subtitle: string; href: string; icon: ShellIconName }>;
const GROUP_ICON: Record<SearchGroup, ShellIconName> = { PAGES: 'more', CONTACTS: 'students', LEADS: 'crm', CLASSES: 'classes', PROGRAMS: 'ranks', CURRICULA: 'ranks' };

/** Remote groups start at this many characters; pages match from the first one. */
export const SEARCH_REMOTE_MIN = 2;
export const SEARCH_DEBOUNCE_MS = 250;
export const SEARCH_CONTACTS_SHOWN = 6;
/** Students are contacts here: the record kinds the palette asks the staff search read for. */
export const SEARCH_RECORD_KINDS: readonly StaffSearchKind[] = ['LEAD', 'CLASS_SESSION', 'PROGRAM', 'CURRICULUM'];
const KIND_GROUP: Partial<Record<StaffSearchKind, SearchGroup>> = { LEAD: 'LEADS', CLASS_SESSION: 'CLASSES', PROGRAM: 'PROGRAMS', CURRICULUM: 'CURRICULA' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Opens the contact card on the contact list. Only the person id travels in the link. */
export function contactHref(personId: string): string {
  if (!UUID.test(personId)) throw new Error('Invalid person.');
  return `/staff/people?${new URLSearchParams({ person: personId.toLowerCase() })}`;
}

const fold = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
/** Bounded to what every read accepts. */
export function searchQuery(raw: string): string { return Array.from(raw.trim()).slice(0, STAFF_SEARCH_QUERY_MAX).join(''); }

/**
 * Menu pages and their tabs whose name, tab or heading matches every typed word. Hidden workflow routes never appear.
 * An empty query lists the menu pages themselves, in menu order.
 */
export function searchPages(language: string, raw: string, selection: OperationalSchoolScope | null): SearchHit[] {
  const t = (key: ShellKey) => shellText(language, key);
  const words = fold(raw).split(' ').filter(Boolean);
  const hits: Array<SearchHit & { rank: number; order: number }> = [];
  let order = 0;
  for (const item of SCHOOL_SHELL_NAV) {
    const section = SCHOOL_SHELL_SECTIONS.find(candidate => candidate.key === item.section);
    const heading = section ? t(section.titleKey) : '';
    const page = t(item.titleKey);
    const listed = schoolShellListed(item);
    const entries = [{ title: page, subtitle: heading || page, route: listed[0] ?? item.routes[0]! },
      ...listed.filter(route => t(route.titleKey) !== page).map(route => ({ title: t(route.titleKey), subtitle: heading ? `${heading} · ${page}` : page, route }))];
    for (const [index, entry] of entries.entries()) {
      order += 1;
      if (!words.length) { if (index === 0) hits.push({ group: 'PAGES', key: `page:${entry.route.href}`, title: entry.title, subtitle: entry.subtitle, href: schoolShellHref(entry.route, selection), icon: item.key, rank: 0, order }); continue; }
      const title = fold(entry.title), all = `${title} ${fold(entry.subtitle)}`;
      if (!words.every(word => all.includes(word))) continue;
      const rank = title.startsWith(words.join(' ')) ? 0 : words.every(word => title.includes(word)) ? 1 : 2;
      hits.push({ group: 'PAGES', key: `page:${entry.route.href}`, title: entry.title, subtitle: entry.subtitle, href: schoolShellHref(entry.route, selection), icon: item.key, rank, order });
    }
  }
  const seen = new Set<string>();
  return hits.sort((a, b) => a.rank - b.rank || a.order - b.order).filter(hit => !seen.has(hit.key) && seen.add(hit.key))
    .map(({ rank: _rank, order: _order, ...hit }) => hit);
}

export type ContactSummary = Readonly<{ personId: string; givenName: string; familyName: string; email: string | null; phoneE164: string | null }>;
export function contactHits(rows: readonly ContactSummary[]): SearchHit[] {
  return rows.slice(0, SEARCH_CONTACTS_SHOWN).map(row => ({ group: 'CONTACTS', key: `contact:${row.personId}`,
    title: `${row.givenName} ${row.familyName}`.trim(), subtitle: row.email ?? row.phoneE164 ?? '', href: contactHref(row.personId), icon: GROUP_ICON.CONTACTS }));
}
export function recordHits(rows: readonly StaffSearchResult[]): SearchHit[] {
  return rows.flatMap(row => { const group = KIND_GROUP[row.kind]; return group ? [{ group, key: `record:${row.kind}:${row.entityId}`, title: row.title, subtitle: row.subtitle, href: row.route, icon: GROUP_ICON[group] }] : []; });
}

export type RemoteState = Readonly<{ state: 'IDLE' | 'LOADING' | 'READY' | 'FAILED' }>;
export type SearchView = Readonly<{ query: string; pages: SearchHit[]; contacts: SearchHit[]; records: SearchHit[]; contactState: RemoteState['state']; recordState: RemoteState['state'] }>;
export type SearchReads = Readonly<{
  contacts: (scope: OperationalSchoolScope, query: string, signal: AbortSignal) => Promise<readonly ContactSummary[]>;
  records: (scope: OperationalSchoolScope, query: string, signal: AbortSignal) => Promise<readonly StaffSearchResult[]>;
}>;

/**
 * One palette's searches. Every new query aborts the reads of the previous one, and a result is shown only while its
 * query, school and run are still current. `clear` (school change, session end, close) drops everything.
 */
export class GlobalSearchRunner {
  private view: SearchView;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private run = 0;
  constructor(private readonly reads: SearchReads, private readonly language: string, private readonly onChange: (view: SearchView) => void) {
    this.view = this.empty('', null);
  }
  current(): SearchView { return this.view; }
  private empty(query: string, selection: OperationalSchoolScope | null): SearchView {
    return { query, pages: searchPages(this.language, query, selection), contacts: [], records: [], contactState: 'IDLE', recordState: 'IDLE' };
  }
  private set(view: SearchView) { this.view = view; this.onChange(view); }
  private stop() { this.run += 1; this.abort?.abort(); this.abort = null; if (this.timer) clearTimeout(this.timer); this.timer = null; }
  search(raw: string, selection: OperationalSchoolScope | null): void {
    this.stop();
    const query = searchQuery(raw);
    if (!selection || Array.from(query).length < SEARCH_REMOTE_MIN) { this.set(this.empty(query, selection)); return; }
    this.set({ ...this.empty(query, selection), contactState: 'LOADING', recordState: 'LOADING' });
    const run = this.run, abort = new AbortController(); this.abort = abort;
    const live = () => run === this.run && !abort.signal.aborted;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.reads.contacts(selection, query, abort.signal).then(rows => contactHits(rows), () => null)
        .then(hits => { if (live()) this.set({ ...this.view, contacts: hits ?? [], contactState: hits ? 'READY' : 'FAILED' }); });
      this.reads.records(selection, query, abort.signal).then(rows => recordHits(rows), () => null)
        .then(hits => { if (live()) this.set({ ...this.view, records: hits ?? [], recordState: hits ? 'READY' : 'FAILED' }); });
    }, SEARCH_DEBOUNCE_MS);
  }
  clear(): void { this.stop(); this.set(this.empty('', null)); }
  dispose(): void { this.stop(); }
}

/** The list the palette shows, in group order: what was found first, pages last. */
export function orderedHits(view: SearchView): SearchHit[] {
  const all = [...view.contacts, ...view.records, ...view.pages];
  return SEARCH_GROUPS.flatMap(group => all.filter(hit => hit.group === group));
}

/** Arrow keys move through the list and wrap; Home and End jump. */
export function moveActive(index: number, count: number, key: string): number {
  if (count < 1) return -1;
  if (key === 'ArrowDown') return index < 0 ? 0 : (index + 1) % count;
  if (key === 'ArrowUp') return index <= 0 ? count - 1 : index - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return index;
}

/** Ctrl+K / ⌘K opens search from anywhere. */
export const isSearchShortcut = (event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): boolean =>
  (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k';
