/**
 * Journey recommendations (0603). Staff with curriculum.manage pin a recommendation to a point on a program's journey (a rank
 * reached, N requirements met at a rank, booked for a belt test, or N classes attended) that points to one of the school's
 * sign-up pages, an event, the pro shop or the school itself. Families see the ones each child has reached on the HON Family
 * app's journey. Nothing is charged, booked or sent by a recommendation. Staff identity is never shown to families.
 */
export const JOURNEY_TRIGGERS = ['RANK_REACHED', 'REQUIREMENTS_MET', 'TEST_BOOKED', 'CLASSES_ATTENDED'] as const;
export const JOURNEY_TARGETS = ['CHECKOUT', 'EVENT', 'PRO_SHOP', 'ASK_SCHOOL'] as const;
export const JOURNEY_RECOMMENDATION_STATUSES = ['ON', 'OFF', 'REMOVED'] as const;
export type JourneyTrigger = (typeof JOURNEY_TRIGGERS)[number];
export type JourneyTarget = (typeof JOURNEY_TARGETS)[number];
export type JourneyRecommendationStatus = (typeof JOURNEY_RECOMMENDATION_STATUSES)[number];
export const JOURNEY_RECOMMENDATION_LIMITS = { title: 80, message: 400, children: 20, perChild: 10, staff: 500, choices: 100, requirements: 100, classes: 1000 } as const;

export interface FamilyJourneyRecommendation {
  recommendationId: string; program: string; rank: string | null; triggerKind: JourneyTrigger; threshold: number | null;
  title: string; message: string; targetKind: JourneyTarget; checkoutId: string | null; eventId: string | null; targetLabel: string | null;
}
export interface ParentJourneyRecommendations { children: { name: string; recommendations: FamilyJourneyRecommendation[] }[] }

export interface JourneyRecommendation {
  recommendationId: string; curriculumId: string; program: string; triggerKind: JourneyTrigger; rankId: string | null; rank: string | null;
  threshold: number | null; title: string; message: string; targetKind: JourneyTarget; targetCheckoutId: string | null; targetEventId: string | null;
  targetLabel: string | null; targetLive: boolean; skipEnrolled: boolean; status: JourneyRecommendationStatus; version: number; updatedAt: string;
}
export interface JourneyRecommendationChoices {
  programs: { curriculumId: string; name: string; ranks: { rankId: string; name: string; order: number }[] }[];
  checkouts: { checkoutId: string; title: string | null }[];
  events: { eventId: string; title: string; localDate: string }[];
}
export interface JourneyRecommendations extends JourneyRecommendationChoices { recommendations: JourneyRecommendation[] }
export interface JourneyRecommendationReceipt { recommendation: JourneyRecommendation }

export interface SaveJourneyRecommendationInput {
  recommendationId: string | null; expectedVersion: number | null; curriculumId: string;
  triggerKind: JourneyTrigger; rankId: string | null; threshold: number | null; title: string; message: string;
  targetKind: JourneyTarget; targetCheckoutId: string | null; targetEventId: string | null; skipEnrolled: boolean;
}
export interface SetJourneyRecommendationStatusInput { recommendationId: string; expectedVersion: number; status: JourneyRecommendationStatus }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LINE_CONTROL = /[\u0000-\u001f\u007f]/;
const TEXT_CONTROL = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/;

function invalid(): never { throw new Error('Invalid journey recommendation data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value; }
function maybeUuid(value: unknown): string | null { return value === null ? null : uuid(value); }
function name(value: unknown, max = 400): string {
  if (typeof value !== 'string' || !value.trim() || [...value].length > max || LINE_CONTROL.test(value)) invalid();
  return value;
}
function maybeName(value: unknown): string | null { return value === null ? null : name(value); }
function whole(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) invalid();
  return value as number;
}
function oneOf<const T extends readonly string[]>(value: unknown, options: T): T[number] {
  if (typeof value !== 'string' || !options.includes(value)) invalid();
  return value as T[number];
}
function instant(value: unknown): string {
  if (typeof value !== 'string' || !INSTANT.test(value) || new Date(value).toISOString() !== value) invalid();
  return value;
}
export function isJourneyTitle(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= JOURNEY_RECOMMENDATION_LIMITS.title && value.trim() !== '' && !LINE_CONTROL.test(value);
}
export function isJourneyMessage(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= JOURNEY_RECOMMENDATION_LIMITS.message && value.replace(/[ \t\r\n]/g, '') !== '' && !TEXT_CONTROL.test(value);
}
function title(value: unknown): string { if (!isJourneyTitle(value)) invalid(); return value; }
function message(value: unknown): string { if (!isJourneyMessage(value)) invalid(); return value; }

/** The trigger and target rules the database enforces, checked the same way before anything is sent. */
function shapeOk(v: { triggerKind: JourneyTrigger; rankId: string | null; threshold: number | null; targetKind: JourneyTarget;
  checkoutId: string | null; eventId: string | null; skipEnrolled?: boolean }): boolean {
  const trigger = v.triggerKind === 'RANK_REACHED' || v.triggerKind === 'TEST_BOOKED' ? v.rankId !== null && v.threshold === null
    : v.triggerKind === 'REQUIREMENTS_MET' ? v.rankId !== null && v.threshold !== null && v.threshold <= JOURNEY_RECOMMENDATION_LIMITS.requirements
    : v.threshold !== null;
  const target = v.targetKind === 'CHECKOUT' ? v.checkoutId !== null && v.eventId === null
    : v.targetKind === 'EVENT' ? v.eventId !== null && v.checkoutId === null : v.checkoutId === null && v.eventId === null;
  return trigger && target && (!v.skipEnrolled || v.targetKind === 'CHECKOUT');
}
function threshold(value: unknown): number | null { return value === null ? null : whole(value, 1, JOURNEY_RECOMMENDATION_LIMITS.classes); }

export function validateSaveJourneyRecommendationInput(value: unknown): SaveJourneyRecommendationInput {
  const row = record(value, ['recommendationId', 'expectedVersion', 'curriculumId', 'triggerKind', 'rankId', 'threshold', 'title', 'message',
    'targetKind', 'targetCheckoutId', 'targetEventId', 'skipEnrolled']);
  const input: SaveJourneyRecommendationInput = {
    recommendationId: maybeUuid(row.recommendationId), expectedVersion: row.expectedVersion === null ? null : whole(row.expectedVersion, 1, 999_999_999),
    curriculumId: uuid(row.curriculumId), triggerKind: oneOf(row.triggerKind, JOURNEY_TRIGGERS), rankId: maybeUuid(row.rankId), threshold: threshold(row.threshold),
    title: title(row.title), message: message(row.message), targetKind: oneOf(row.targetKind, JOURNEY_TARGETS),
    targetCheckoutId: maybeUuid(row.targetCheckoutId), targetEventId: maybeUuid(row.targetEventId),
    skipEnrolled: typeof row.skipEnrolled === 'boolean' ? row.skipEnrolled : invalid(),
  };
  if ((input.recommendationId === null) !== (input.expectedVersion === null)
    || !shapeOk({ ...input, checkoutId: input.targetCheckoutId, eventId: input.targetEventId })) invalid();
  return input;
}
export function validateSetJourneyRecommendationStatusInput(value: unknown): SetJourneyRecommendationStatusInput {
  const row = record(value, ['recommendationId', 'expectedVersion', 'status']);
  return { recommendationId: uuid(row.recommendationId), expectedVersion: whole(row.expectedVersion, 1, 999_999_999), status: oneOf(row.status, JOURNEY_RECOMMENDATION_STATUSES) };
}

function familyItem(value: unknown): FamilyJourneyRecommendation {
  const row = record(value, ['recommendationId', 'program', 'rank', 'triggerKind', 'threshold', 'title', 'message', 'targetKind', 'checkoutId', 'eventId', 'targetLabel']);
  const item: FamilyJourneyRecommendation = {
    recommendationId: uuid(row.recommendationId), program: name(row.program), rank: maybeName(row.rank), triggerKind: oneOf(row.triggerKind, JOURNEY_TRIGGERS),
    threshold: threshold(row.threshold), title: title(row.title), message: message(row.message), targetKind: oneOf(row.targetKind, JOURNEY_TARGETS),
    checkoutId: maybeUuid(row.checkoutId), eventId: maybeUuid(row.eventId), targetLabel: maybeName(row.targetLabel),
  };
  if (!shapeOk({ ...item, rankId: item.rank })
    || ((item.targetKind === 'CHECKOUT' || item.targetKind === 'EVENT') !== (item.targetLabel !== null))) invalid();
  return item;
}
export function verifyParentJourneyRecommendations(value: unknown): ParentJourneyRecommendations {
  const row = record(value, ['children']);
  if (!Array.isArray(row.children) || row.children.length > JOURNEY_RECOMMENDATION_LIMITS.children) invalid();
  const children = row.children.map(child => {
    const c = record(child, ['name', 'recommendations']);
    if (!Array.isArray(c.recommendations) || c.recommendations.length > JOURNEY_RECOMMENDATION_LIMITS.perChild) invalid();
    const recommendations = c.recommendations.map(familyItem);
    if (new Set(recommendations.map(r => r.recommendationId)).size !== recommendations.length) invalid();
    return { name: name(c.name), recommendations };
  });
  return { children };
}

export function verifyJourneyRecommendation(value: unknown): JourneyRecommendation {
  const row = record(value, ['recommendationId', 'curriculumId', 'program', 'triggerKind', 'rankId', 'rank', 'threshold', 'title', 'message', 'targetKind',
    'targetCheckoutId', 'targetEventId', 'targetLabel', 'targetLive', 'skipEnrolled', 'status', 'version', 'updatedAt']);
  const item: JourneyRecommendation = {
    recommendationId: uuid(row.recommendationId), curriculumId: uuid(row.curriculumId), program: name(row.program), triggerKind: oneOf(row.triggerKind, JOURNEY_TRIGGERS),
    rankId: maybeUuid(row.rankId), rank: maybeName(row.rank), threshold: threshold(row.threshold), title: title(row.title), message: message(row.message),
    targetKind: oneOf(row.targetKind, JOURNEY_TARGETS), targetCheckoutId: maybeUuid(row.targetCheckoutId), targetEventId: maybeUuid(row.targetEventId),
    targetLabel: maybeName(row.targetLabel), targetLive: typeof row.targetLive === 'boolean' ? row.targetLive : invalid(),
    skipEnrolled: typeof row.skipEnrolled === 'boolean' ? row.skipEnrolled : invalid(), status: oneOf(row.status, JOURNEY_RECOMMENDATION_STATUSES),
    version: whole(row.version, 1, 999_999_999), updatedAt: instant(row.updatedAt),
  };
  if (!shapeOk({ ...item, checkoutId: item.targetCheckoutId, eventId: item.targetEventId }) || (item.rankId === null) !== (item.rank === null)) invalid();
  return item;
}
export function verifyJourneyRecommendations(value: unknown): JourneyRecommendations {
  const row = record(value, ['recommendations', 'programs', 'checkouts', 'events']);
  const L = JOURNEY_RECOMMENDATION_LIMITS;
  if (!Array.isArray(row.recommendations) || row.recommendations.length > L.staff || !Array.isArray(row.programs) || row.programs.length > L.choices
    || !Array.isArray(row.checkouts) || row.checkouts.length > L.choices || !Array.isArray(row.events) || row.events.length > L.choices) invalid();
  return {
    recommendations: row.recommendations.map(verifyJourneyRecommendation),
    programs: row.programs.map(p => {
      const r = record(p, ['curriculumId', 'name', 'ranks']);
      if (!Array.isArray(r.ranks) || r.ranks.length > 200) invalid();
      return { curriculumId: uuid(r.curriculumId), name: name(r.name), ranks: r.ranks.map(k => {
        const x = record(k, ['rankId', 'name', 'order']);
        return { rankId: uuid(x.rankId), name: name(x.name), order: whole(x.order, 1, 2_147_483_647) };
      }) };
    }),
    checkouts: row.checkouts.map(c => { const r = record(c, ['checkoutId', 'title']); return { checkoutId: uuid(r.checkoutId), title: maybeName(r.title) }; }),
    events: row.events.map(e => {
      const r = record(e, ['eventId', 'title', 'localDate']);
      if (typeof r.localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.localDate)) invalid();
      return { eventId: uuid(r.eventId), title: name(r.title), localDate: r.localDate };
    }),
  };
}
export function verifyJourneyRecommendationReceipt(value: unknown, expected: { recommendationId?: string; status?: JourneyRecommendationStatus; title?: string }): JourneyRecommendationReceipt {
  const row = record(value, ['recommendation']);
  const recommendation = verifyJourneyRecommendation(row.recommendation);
  if ((expected.recommendationId !== undefined && recommendation.recommendationId !== expected.recommendationId)
    || (expected.status !== undefined && recommendation.status !== expected.status)
    || (expected.title !== undefined && recommendation.title !== expected.title)) invalid();
  return { recommendation };
}

// 0608 J1b: a family's answer ("Not now" hides it for the family; "See how to join" records interest) and the staff interest list.
export const JOURNEY_RESPONSE_KINDS = ['HIDDEN', 'INTERESTED'] as const;
export type JourneyResponseKind = (typeof JOURNEY_RESPONSE_KINDS)[number];
export const JOURNEY_INTEREST_LIMIT = 500;
export interface ParentJourneyResponseInput { kind: JourneyResponseKind }
export interface ParentJourneyResponseReceipt { recommendationId: string; kind: JourneyResponseKind; recordedAt: string; replayed: boolean }
export interface JourneyRecommendationInterest {
  interest: { recommendationId: string; familyId: string; familyName: string; children: string[]; recordedAt: string }[];
}
export function validateParentJourneyResponseInput(value: unknown): ParentJourneyResponseInput {
  const row = record(value, ['kind']);
  return { kind: oneOf(row.kind, JOURNEY_RESPONSE_KINDS) };
}
export function verifyParentJourneyResponseReceipt(value: unknown, expected: { recommendationId: string; kind: JourneyResponseKind }): ParentJourneyResponseReceipt {
  const row = record(value, ['recommendationId', 'kind', 'recordedAt', 'replayed']);
  const receipt: ParentJourneyResponseReceipt = { recommendationId: uuid(row.recommendationId), kind: oneOf(row.kind, JOURNEY_RESPONSE_KINDS),
    recordedAt: instant(row.recordedAt), replayed: typeof row.replayed === 'boolean' ? row.replayed : invalid() };
  if (receipt.recommendationId !== expected.recommendationId.toLowerCase() || receipt.kind !== expected.kind) invalid();
  return receipt;
}
export function verifyJourneyRecommendationInterest(value: unknown): JourneyRecommendationInterest {
  const row = record(value, ['interest']);
  if (!Array.isArray(row.interest) || row.interest.length > JOURNEY_INTEREST_LIMIT) invalid();
  const seen = new Set<string>();
  return { interest: row.interest.map(item => {
    const i = record(item, ['recommendationId', 'familyId', 'familyName', 'children', 'recordedAt']);
    if (!Array.isArray(i.children) || i.children.length > JOURNEY_RECOMMENDATION_LIMITS.children) invalid();
    const recommendationId = uuid(i.recommendationId), familyId = uuid(i.familyId);
    // One answer per family and recommendation (0608 UNIQUE): a repeat is not a verified list.
    if (seen.has(`${recommendationId}/${familyId}`)) invalid();
    seen.add(`${recommendationId}/${familyId}`);
    return { recommendationId, familyId, familyName: name(i.familyName), children: i.children.map(c => name(c)), recordedAt: instant(i.recordedAt) };
  }) };
}
