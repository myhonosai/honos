import {
  HQ_BLAST_PICK_MAX, hqBlastBodyMax, hqBlastTagsIn, validateHqBlastSaveInput, type HqBlast, type HqBlastAudience, type HqBlastChannel,
  type HqBlastPurpose, type HqBlastSaveInput,
} from '@hon/contracts';

/**
 * HB2 (0712): the HQ blast composer's working copy, in memory only. Filters are form values ('' = not set). The server
 * checks everything again on save and decides the audience; nothing here grants anything.
 */
export type TriState = '' | 'yes' | 'no';
export type HqBlastFilterForm = Readonly<{
  statuses: readonly ('ACTIVE' | 'PAUSED')[];
  planNames: readonly string[]; noPlan: boolean; founder: TriState; billingIntervals: readonly ('MONTHLY' | 'ANNUAL' | 'ONE_TIME')[]; freePlan: TriState;
  trial: '' | 'ON_TRIAL' | 'TRIAL_ENDED' | 'NEVER'; trialEndsWithinDays: '' | '7' | '14' | '30';
  joined: '' | '7' | '30' | '90' | 'RANGE'; joinedFrom: string; joinedTo: string;
  countries: readonly string[]; regions: readonly string[]; cities: string;
  featuresIncluded: readonly string[]; featuresMissing: readonly string[]; canGetTexts: boolean;
}>;
export const NO_HQ_BLAST_FILTERS: HqBlastFilterForm = {
  statuses: [], planNames: [], noPlan: false, founder: '', billingIntervals: [], freePlan: '', trial: '', trialEndsWithinDays: '',
  joined: '', joinedFrom: '', joinedTo: '', countries: [], regions: [], cities: '', featuresIncluded: [], featuresMissing: [], canGetTexts: false,
};
/** A school picked by name. The name is known for schools seen in this session; a reopened draft may have ids only. */
export type PickedSchool = Readonly<{ schoolId: string; name: string | null }>;
export type HqBlastDraft = Readonly<{
  blastId: string | null; version: number; name: string; channel: HqBlastChannel; purpose: HqBlastPurpose; subject: string; body: string;
  filters: HqBlastFilterForm; picked: readonly PickedSchool[]; leftOut: readonly PickedSchool[];
}>;
export type HqBlastProblem = 'name' | 'subject' | 'body' | 'bodyLength' | 'mergeTag' | 'joined' | 'cities' | 'picks';

export function newHqBlastDraft(): HqBlastDraft {
  return { blastId: null, version: 0, name: '', channel: 'EMAIL', purpose: 'ANNOUNCEMENT', subject: '', body: '', filters: NO_HQ_BLAST_FILTERS, picked: [], leftOut: [] };
}

const tri = (v: boolean | undefined): TriState => v === undefined ? '' : v ? 'yes' : 'no';
/** A saved blast as the composer's form. School names come from `names` when this session has seen them. */
export function hqBlastDraftOf(blast: HqBlast, names: ReadonlyMap<string, string> = new Map()): HqBlastDraft {
  const a = blast.audience;
  const pick = (ids: readonly string[] | undefined) => (ids ?? []).map((schoolId) => ({ schoolId, name: names.get(schoolId.toLowerCase()) ?? null }));
  return {
    blastId: blast.blastId, version: blast.version, name: blast.name, channel: blast.channel, purpose: blast.purpose, subject: blast.subject ?? '', body: blast.body,
    filters: {
      statuses: a.statuses ?? [], planNames: a.planNames ?? [], noPlan: a.noPlan === true, founder: tri(a.founder), billingIntervals: a.billingIntervals ?? [],
      freePlan: tri(a.freePlan), trial: a.trial ?? '', trialEndsWithinDays: a.trialEndsWithinDays ? String(a.trialEndsWithinDays) as '7' | '14' | '30' : '',
      joined: a.joinedWithinDays ? String(a.joinedWithinDays) as '7' | '30' | '90' : a.joinedFrom || a.joinedTo ? 'RANGE' : '',
      joinedFrom: a.joinedFrom ?? '', joinedTo: a.joinedTo ?? '', countries: a.countries ?? [], regions: a.regions ?? [], cities: (a.cities ?? []).join(', '),
      featuresIncluded: a.featuresIncluded ?? [], featuresMissing: a.featuresMissing ?? [], canGetTexts: a.canGetTexts === true,
    },
    picked: pick(a.schools), leftOut: pick(a.excludeSchools),
  };
}

export function citiesOf(text: string): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const raw of text.split(',')) {
    const c = raw.trim();
    if (c && !seen.has(c.toLowerCase())) { seen.add(c.toLowerCase()); out.push(c); }
  }
  return out;
}

/** The form as the closed 0712 audience. Unset filters are left out; {} means every active and paused school. */
export function hqBlastAudienceOf(draft: HqBlastDraft): HqBlastAudience {
  const f = draft.filters, a: HqBlastAudience = {};
  if (f.statuses.length) a.statuses = [...f.statuses];
  if (f.planNames.length) a.planNames = [...f.planNames];
  if (f.noPlan) a.noPlan = true;
  if (f.founder) a.founder = f.founder === 'yes';
  if (f.billingIntervals.length) a.billingIntervals = [...f.billingIntervals];
  if (f.freePlan) a.freePlan = f.freePlan === 'yes';
  if (f.trial) a.trial = f.trial;
  if (f.trialEndsWithinDays && (f.trial === '' || f.trial === 'ON_TRIAL')) a.trialEndsWithinDays = Number(f.trialEndsWithinDays) as 7 | 14 | 30;
  if (f.joined === 'RANGE') { if (f.joinedFrom) a.joinedFrom = f.joinedFrom; if (f.joinedTo) a.joinedTo = f.joinedTo; }
  else if (f.joined) a.joinedWithinDays = Number(f.joined) as 7 | 30 | 90;
  if (f.countries.length) a.countries = [...f.countries];
  if (f.regions.length) a.regions = [...f.regions];
  const cities = citiesOf(f.cities);
  if (cities.length) a.cities = cities;
  if (f.featuresIncluded.length) a.featuresIncluded = [...f.featuresIncluded];
  if (f.featuresMissing.length) a.featuresMissing = [...f.featuresMissing];
  if (f.canGetTexts) a.canGetTexts = true;
  if (draft.picked.length) a.schools = draft.picked.map((s) => s.schoolId);
  if (draft.leftOut.length) a.excludeSchools = draft.leftOut.map((s) => s.schoolId);
  return a;
}

/** What is wrong with the draft, in the person's terms. Empty means it can be saved. */
export function hqBlastProblems(draft: HqBlastDraft): HqBlastProblem[] {
  const out: HqBlastProblem[] = [];
  const name = draft.name.trim(), subject = draft.subject.trim(), body = draft.body.trim();
  if (!name || name.length > 100 || /[\t\n\r]/.test(name)) out.push('name');
  if (draft.channel === 'EMAIL' && (!subject || subject.length > 150 || /[\t\n\r]/.test(subject))) out.push('subject');
  if (!body) out.push('body');
  else if (body.length > hqBlastBodyMax(draft.channel)) out.push('bodyLength');
  if (/\{\{(?!(?:first_name|school_name|hq_name)\}\})/.test(body) || /\{\{(?!(?:first_name|school_name|hq_name)\}\})/.test(subject)) out.push('mergeTag');
  const f = draft.filters;
  if (f.joined === 'RANGE' && ((!f.joinedFrom && !f.joinedTo) || (f.joinedFrom && f.joinedTo && f.joinedFrom > f.joinedTo))) out.push('joined');
  const cities = citiesOf(f.cities);
  if (cities.length > 20 || cities.some((c) => c.length > 100)) out.push('cities');
  if (draft.picked.length > HQ_BLAST_PICK_MAX || draft.leftOut.length > HQ_BLAST_PICK_MAX) out.push('picks');
  return out;
}

/** The draft as the closed save request, or null when the server would refuse it. */
export function hqBlastSaveInput(draft: HqBlastDraft): HqBlastSaveInput | null {
  if (hqBlastProblems(draft).length) return null;
  try {
    return validateHqBlastSaveInput({ blastId: draft.blastId, expectedVersion: draft.version, name: draft.name.trim(), channel: draft.channel, purpose: draft.purpose,
      subject: draft.channel === 'EMAIL' ? draft.subject.trim() : null, body: draft.body.trim(), audience: hqBlastAudienceOf(draft) });
  } catch { return null; }
}

/** The same request the server would see: used to tell whether the open draft has unsaved changes. */
export function hqBlastSameAsSaved(draft: HqBlastDraft, saved: HqBlastDraft | null): boolean {
  if (!saved) return false;
  const a = hqBlastSaveInput(draft), b = hqBlastSaveInput(saved);
  return !!a && !!b && JSON.stringify({ ...a, expectedVersion: 0 }) === JSON.stringify({ ...b, expectedVersion: 0 });
}

/** Puts a merge tag at the cursor (or the end). Returns the new text and where the cursor goes. */
export function insertHqBlastTag(text: string, tag: 'first_name' | 'school_name' | 'hq_name', start = text.length, end = start): { text: string; cursor: number } {
  const s = Math.max(0, Math.min(start, text.length)), e = Math.max(s, Math.min(end, text.length)), token = `{{${tag}}}`;
  return { text: text.slice(0, s) + token + text.slice(e), cursor: s + token.length };
}
export const hqBlastTags = (draft: HqBlastDraft): string[] => hqBlastTagsIn(`${draft.subject}\n${draft.body}`);

export function togglePick(list: readonly PickedSchool[], school: PickedSchool): PickedSchool[] {
  const id = school.schoolId.toLowerCase();
  return list.some((s) => s.schoolId.toLowerCase() === id) ? list.filter((s) => s.schoolId.toLowerCase() !== id) : [...list, { schoolId: id, name: school.name }];
}
export function toggleIn<T extends string>(list: readonly T[], value: T): T[] { return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]; }

/** Picks a send time from a datetime-local value, in the browser's time. Null when empty or not a time 1 minute to 60 days ahead. */
export function hqBlastSendAt(local: string, now = Date.now()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const at = new Date(local).getTime();
  if (!Number.isFinite(at) || at < now + 60_000 || at > now + 60 * 86_400_000) return null;
  return new Date(at).toISOString();
}
/** A queued blast can be called off while none of its messages has gone to the sender. The server decides finally. */
export function hqBlastMayCancel(blast: HqBlast, deliveries: { sending: number; accepted: number; delivered: number; bounced: number; failed: number; unknown: number }): boolean {
  return blast.status === 'QUEUED' && deliveries.sending + deliveries.accepted + deliveries.delivered + deliveries.bounced + deliveries.failed + deliveries.unknown === 0;
}
