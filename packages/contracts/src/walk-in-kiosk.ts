/**
 * Walk-in kiosk (0396, docs/architecture/WALK_IN_KIOSK.md). A school tablet where a visitor fills a short form, signs the
 * school's waiver and picks a day pass or a trial. Staff with walkin_kiosk.run start tablets and see walk-ins; the owner
 * (walkin_kiosk.manage) sets the waiver, offers and prices. The tablet can only create a new walk-in; it never reads people.
 * Paying on the tablet or by QR comes in 0397; here a paid offer is "pay at the front desk".
 */
export const WALKIN_LANGUAGES = ['en', 'ko', 'es'] as const;
export type WalkInLanguage = (typeof WALKIN_LANGUAGES)[number];
export const WALKIN_OFFER_KINDS = ['DAY_PASS', 'TRIAL'] as const;
export type WalkInOfferKind = (typeof WALKIN_OFFER_KINDS)[number];
export const WALKIN_PAYMENT_STATES = ['FREE', 'PAY_AT_DESK', 'PAID_AT_DESK'] as const;
export type WalkInPaymentState = (typeof WALKIN_PAYMENT_STATES)[number];
export const WALKIN_DESK_METHODS = ['CASH', 'CARD_OUTSIDE_HON', 'OTHER'] as const;
export type WalkInDeskMethod = (typeof WALKIN_DESK_METHODS)[number];
export const WALKIN_HEARD_FROM = ['', 'FRIEND', 'SEARCH', 'SOCIAL', 'WALKED_BY', 'EVENT', 'OTHER'] as const;
export type WalkInHeardFrom = (typeof WALKIN_HEARD_FROM)[number];
export const WALKIN_RELATIONSHIPS = ['PARENT', 'LEGAL_GUARDIAN'] as const;
export type WalkInRelationship = (typeof WALKIN_RELATIONSHIPS)[number];
export const WALKIN_SIGNER_RELATIONSHIPS = ['SELF', 'PARENT', 'LEGAL_GUARDIAN', 'SELF_AND_PARENT', 'SELF_AND_LEGAL_GUARDIAN'] as const;
export type WalkInSignerRelationship = (typeof WALKIN_SIGNER_RELATIONSHIPS)[number];
export const WALKIN_VISIT_RESULTS = ['RECORDED', 'INVALID', 'STALE', 'CLOSED', 'RATE_LIMITED', 'UNAVAILABLE'] as const;
export type WalkInVisitResult = (typeof WALKIN_VISIT_RESULTS)[number];
export const WALKIN_LIMITS = {
  waiver: 8000, thankYou: 300, offerName: 60, offerDescription: 200, offers: 6, maxPriceMinor: 1_000_000, name: 60, signerName: 120,
  emergencyName: 120, label: 40, maxHours: 12, children: 3, strokes: 40, points: 2000, strokeBytes: 16384, maxDevices: 10,
} as const;

/** English required, Korean and Spanish optional. */
export interface WalkInText { en: string; ko?: string; es?: string }
export interface WalkInOffer { key: string; kind: WalkInOfferKind; name: WalkInText; description: WalkInText; priceMinor: number }
export interface WalkInSettingsInput {
  expectedVersion: number; enabled: boolean; waiver: WalkInText; emergencyRequired: boolean; pipelineId: string; pipelineStageId: string;
  offers: WalkInOffer[]; thankYou: WalkInText;
}
export interface WalkInSettings extends Omit<WalkInSettingsInput, 'expectedVersion'> { waiverVersion: number; version: number; updatedAt: string }
export interface WalkInPipelineChoice { pipelineId: string; name: string; stages: { stageId: string; name: string }[] }
export interface WalkInSettingsRead { settings: WalkInSettings | null; pipelines: WalkInPipelineChoice[] }
export interface WalkInDevice { deviceId: string; label: string; startedAt: string; endsAt: string; endedAt: string | null; live: boolean; version: number; startedBy: string | null }
export interface WalkInParticipant { givenName: string; familyName: string; birthDate: string; isContact: boolean; isMinor: boolean }
export interface WalkInVisit {
  visitId: string; leadId: string; createdAt: string; localDate: string; language: WalkInLanguage;
  offer: { key: string; kind: WalkInOfferKind; name: string; priceMinor: number; currency: 'USD' };
  paymentState: WalkInPaymentState; deskMethod: WalkInDeskMethod | null; deskPaidAt: string | null;
  contact: { givenName: string; familyName: string; email: string | null; mobile: string | null };
  participants: WalkInParticipant[]; emergencyName: string; emergencyPhone: string; heardFrom: WalkInHeardFrom; marketingOptIn: boolean;
  waiverSignedAt: string | null; version: number;
}
export interface WalkInOverview { canManage: boolean; configured: boolean; enabled: boolean; devices: WalkInDevice[]; visits: WalkInVisit[] }
export type WalkInStroke = [number, number][];
export interface WalkInSignedWaiver {
  version: number; language: WalkInLanguage; text: string; textHash: string; signerName: string; relationship: WalkInSignerRelationship;
  strokes: WalkInStroke[]; signedAt: string;
}
export interface WalkInVisitDetail { visit: WalkInVisit; waiver: WalkInSignedWaiver }
export interface StartWalkInDeviceInput { label: string; hours: number }
export interface EndWalkInDeviceInput { expectedVersion: number }
export interface WalkInDeskPaidInput { expectedVersion: number; method: WalkInDeskMethod }
/** What the started tablet receives once: the device and its token (kept in memory only). */
export interface StartedWalkInDevice { device: WalkInDevice; token: string | null }

/** What the tablet reads. */
export interface WalkInTerminal {
  schoolName: string; branding: { logoUrl: string | null; accentColor: string | null }; endsAt: string; settingsVersion: number;
  waiver: WalkInText; emergencyRequired: boolean; offers: (WalkInOffer & { currency: 'USD' })[]; thankYou: WalkInText;
}
export interface WalkInVisitInput {
  settingsVersion: number; language: WalkInLanguage;
  contact: { givenName: string; familyName: string; email: string; mobile: string; birthDate: string | null; isParticipant: boolean; adultConfirmed: true };
  children: { givenName: string; familyName: string; birthDate: string }[];
  relationship: WalkInRelationship | null; emergency: { name: string; phone: string }; heardFrom: WalkInHeardFrom; marketingOptIn: boolean;
  offerKey: string; waiver: { accepted: true; signerName: string; strokes: WalkInStroke[] }; website: '';
}
export interface WalkInVisitOutcome {
  result: WalkInVisitResult; firstName?: string; paymentState?: WalkInPaymentState; priceMinor?: number; thankYou?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OFFER_KEY = /^[a-z0-9][a-z0-9-]{0,23}$/;
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/;
const E164 = /^\+[1-9][0-9]{6,14}$/;
export const WALKIN_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function fail(): never { throw new Error('Invalid walk-in kiosk value.'); }
function object(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!keys.includes(key) && !optional.includes(key)) fail();
  for (const key of keys) if (!(key in record)) fail();
  return record;
}
/** One-line text: trimmed, no angle brackets or control characters (the 0261 rule); multiline allows line breaks. */
export function isWalkInText(value: unknown, min: number, max: number, multiline = false): value is string {
  if (typeof value !== 'string' || value.length < min || value.length > max) return false;
  if (value.length && value.trim() !== value) return false;
  // eslint-disable-next-line no-control-regex
  const control = multiline ? /[\u0000-\u0009\u000b-\u001f\u007f<>]/ : /[\u0000-\u001f\u007f<>]/;
  return !control.test(value);
}
function text(value: unknown, min: number, max: number, multiline: boolean): WalkInText {
  const record = object(value, ['en'], ['ko', 'es']);
  for (const [key, entry] of Object.entries(record)) if (!isWalkInText(entry, key === 'en' ? min : 0, max, multiline)) fail();
  return record as unknown as WalkInText;
}
const integer = (value: unknown, min: number, max: number): number => (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fail());
const uuid = (value: unknown): string => (typeof value === 'string' && UUID.test(value) ? value : fail());
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T => (typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fail());

export function validateWalkInSettingsInput(value: unknown): WalkInSettingsInput {
  const p = object(value, ['expectedVersion', 'enabled', 'waiver', 'emergencyRequired', 'pipelineId', 'pipelineStageId', 'offers', 'thankYou']);
  if (typeof p.enabled !== 'boolean' || typeof p.emergencyRequired !== 'boolean' || !Array.isArray(p.offers)) fail();
  const offers = p.offers as unknown[];
  if (offers.length < 1 || offers.length > WALKIN_LIMITS.offers) fail();
  const keys = new Set<string>();
  const normalized = offers.map(entry => {
    const o = object(entry, ['key', 'kind', 'name', 'description', 'priceMinor']);
    if (typeof o.key !== 'string' || !OFFER_KEY.test(o.key) || keys.has(o.key)) fail();
    keys.add(o.key);
    return { key: o.key, kind: oneOf(o.kind, WALKIN_OFFER_KINDS), name: text(o.name, 1, WALKIN_LIMITS.offerName, false),
      description: text(o.description, 0, WALKIN_LIMITS.offerDescription, false), priceMinor: integer(o.priceMinor, 0, WALKIN_LIMITS.maxPriceMinor) };
  });
  return { expectedVersion: integer(p.expectedVersion, 0, 999_999_999), enabled: p.enabled, waiver: text(p.waiver, 1, WALKIN_LIMITS.waiver, true),
    emergencyRequired: p.emergencyRequired, pipelineId: uuid(p.pipelineId), pipelineStageId: uuid(p.pipelineStageId), offers: normalized,
    thankYou: text(p.thankYou, 0, WALKIN_LIMITS.thankYou, false) };
}
export function validateStartWalkInDeviceInput(value: unknown): StartWalkInDeviceInput {
  const p = object(value, ['label', 'hours']);
  if (!isWalkInText(p.label, 1, WALKIN_LIMITS.label)) fail();
  return { label: p.label as string, hours: integer(p.hours, 1, WALKIN_LIMITS.maxHours) };
}
export function validateEndWalkInDeviceInput(value: unknown): EndWalkInDeviceInput {
  return { expectedVersion: integer(object(value, ['expectedVersion']).expectedVersion, 1, 999_999_999) };
}
export function validateWalkInDeskPaidInput(value: unknown): WalkInDeskPaidInput {
  const p = object(value, ['expectedVersion', 'method']);
  return { expectedVersion: integer(p.expectedVersion, 1, 999_999_999), method: oneOf(p.method, WALKIN_DESK_METHODS) };
}

/** Whole years between a YYYY-MM-DD birth date and a YYYY-MM-DD local date. */
export function walkInAge(birthDate: string, today: string): number {
  const [by, bm, bd] = birthDate.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}
function birthDate(value: unknown, today: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail();
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value < '1900-01-01' || value > today) fail();
  return value;
}
/** The tablet's own check before sending (the database checks it all again against the live settings). */
export function validateWalkInVisitInput(value: unknown, today: string): WalkInVisitInput {
  const p = object(value, ['settingsVersion', 'language', 'contact', 'children', 'relationship', 'emergency', 'heardFrom', 'marketingOptIn', 'offerKey', 'waiver', 'website']);
  const c = object(p.contact, ['givenName', 'familyName', 'email', 'mobile', 'birthDate', 'isParticipant', 'adultConfirmed']);
  if (!isWalkInText(c.givenName, 1, WALKIN_LIMITS.name) || !isWalkInText(c.familyName, 1, WALKIN_LIMITS.name) || typeof c.email !== 'string'
    || typeof c.mobile !== 'string' || typeof c.isParticipant !== 'boolean' || c.adultConfirmed !== true) fail();
  const email = c.email.toLowerCase(), mobile = c.mobile;
  if ((!email && !mobile) || (email && (email.length > 254 || !EMAIL.test(email))) || (mobile && !E164.test(mobile))) fail();
  let contactBirth: string | null = null;
  if (c.isParticipant) { contactBirth = birthDate(c.birthDate, today); if (walkInAge(contactBirth, today) < 18) fail(); }
  else if (c.birthDate !== null) fail();
  if (!Array.isArray(p.children) || p.children.length > WALKIN_LIMITS.children) fail();
  const children = (p.children as unknown[]).map(entry => {
    const ch = object(entry, ['givenName', 'familyName', 'birthDate']);
    if (!isWalkInText(ch.givenName, 1, WALKIN_LIMITS.name) || !isWalkInText(ch.familyName, 1, WALKIN_LIMITS.name)) fail();
    const born = birthDate(ch.birthDate, today);
    if (walkInAge(born, today) >= 18) fail();
    return { givenName: ch.givenName as string, familyName: ch.familyName as string, birthDate: born };
  });
  if (!c.isParticipant && !children.length) fail();
  const relationship = children.length ? oneOf(p.relationship, WALKIN_RELATIONSHIPS) : p.relationship === null ? null : fail();
  const e = object(p.emergency, ['name', 'phone']);
  if (!isWalkInText(e.name, 0, WALKIN_LIMITS.emergencyName) || typeof e.phone !== 'string' || (e.phone && !E164.test(e.phone)) || (!e.name !== !e.phone)) fail();
  if (typeof p.marketingOptIn !== 'boolean' || typeof p.offerKey !== 'string' || !OFFER_KEY.test(p.offerKey) || p.website !== '') fail();
  const w = object(p.waiver, ['accepted', 'signerName', 'strokes']);
  if (w.accepted !== true || !isWalkInText(w.signerName, 1, WALKIN_LIMITS.signerName)) fail();
  const strokes = validateWalkInStrokes(w.strokes);
  return {
    settingsVersion: integer(p.settingsVersion, 1, 999_999_999), language: oneOf(p.language, WALKIN_LANGUAGES),
    contact: { givenName: c.givenName as string, familyName: c.familyName as string, email, mobile, birthDate: contactBirth, isParticipant: c.isParticipant, adultConfirmed: true },
    children, relationship, emergency: { name: e.name as string, phone: e.phone }, heardFrom: oneOf(p.heardFrom, WALKIN_HEARD_FROM),
    marketingOptIn: p.marketingOptIn, offerKey: p.offerKey, waiver: { accepted: true, signerName: w.signerName as string, strokes }, website: '',
  };
}
/** 1-40 strokes, 2-2000 points in all, integer coordinates 0-1000, at most 16 KiB as JSON. */
export function validateWalkInStrokes(value: unknown): WalkInStroke[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > WALKIN_LIMITS.strokes) fail();
  let points = 0;
  for (const stroke of value as unknown[]) {
    if (!Array.isArray(stroke) || !stroke.length) fail();
    for (const point of stroke as unknown[]) {
      if (!Array.isArray(point) || point.length !== 2) fail();
      integer(point[0], 0, 1000); integer(point[1], 0, 1000); points += 1;
    }
  }
  if (points < 2 || points > WALKIN_LIMITS.points || JSON.stringify(value).length > WALKIN_LIMITS.strokeBytes) fail();
  return value as WalkInStroke[];
}

// Response checks: unknown shapes are never shown as success.
const iso = (value: unknown): string => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ? value : fail());
const isoOrNull = (value: unknown): string | null => (value === null ? null : iso(value));
function device(value: unknown): WalkInDevice {
  const d = object(value, ['deviceId', 'label', 'startedAt', 'endsAt', 'endedAt', 'live', 'version', 'startedBy']);
  if (typeof d.label !== 'string' || typeof d.live !== 'boolean' || (d.startedBy !== null && typeof d.startedBy !== 'string')) fail();
  return { deviceId: uuid(d.deviceId), label: d.label, startedAt: iso(d.startedAt), endsAt: iso(d.endsAt), endedAt: isoOrNull(d.endedAt), live: d.live,
    version: integer(d.version, 1, 999_999_999), startedBy: d.startedBy as string | null };
}
function visit(value: unknown): WalkInVisit {
  const v = object(value, ['visitId', 'leadId', 'createdAt', 'localDate', 'language', 'offer', 'paymentState', 'deskMethod', 'deskPaidAt', 'contact', 'participants',
    'emergencyName', 'emergencyPhone', 'heardFrom', 'marketingOptIn', 'waiverSignedAt', 'version']);
  const offer = object(v.offer, ['key', 'kind', 'name', 'priceMinor', 'currency']);
  const contact = object(v.contact, ['givenName', 'familyName', 'email', 'mobile']);
  if (!Array.isArray(v.participants) || !v.participants.length || typeof v.localDate !== 'string' || typeof v.marketingOptIn !== 'boolean'
    || typeof v.emergencyName !== 'string' || typeof v.emergencyPhone !== 'string' || typeof offer.name !== 'string' || offer.currency !== 'USD'
    || typeof contact.givenName !== 'string' || typeof contact.familyName !== 'string') fail();
  return {
    visitId: uuid(v.visitId), leadId: uuid(v.leadId), createdAt: iso(v.createdAt), localDate: v.localDate, language: oneOf(v.language, WALKIN_LANGUAGES),
    offer: { key: String(offer.key), kind: oneOf(offer.kind, WALKIN_OFFER_KINDS), name: offer.name, priceMinor: integer(offer.priceMinor, 0, WALKIN_LIMITS.maxPriceMinor), currency: 'USD' },
    paymentState: oneOf(v.paymentState, WALKIN_PAYMENT_STATES), deskMethod: v.deskMethod === null ? null : oneOf(v.deskMethod, WALKIN_DESK_METHODS), deskPaidAt: isoOrNull(v.deskPaidAt),
    contact: { givenName: contact.givenName, familyName: contact.familyName, email: (contact.email as string | null) ?? null, mobile: (contact.mobile as string | null) ?? null },
    participants: (v.participants as unknown[]).map(entry => {
      const x = object(entry, ['givenName', 'familyName', 'birthDate', 'isContact', 'isMinor']);
      if (typeof x.givenName !== 'string' || typeof x.familyName !== 'string' || typeof x.birthDate !== 'string' || typeof x.isContact !== 'boolean' || typeof x.isMinor !== 'boolean') fail();
      return x as unknown as WalkInParticipant;
    }),
    emergencyName: v.emergencyName, emergencyPhone: v.emergencyPhone, heardFrom: oneOf(v.heardFrom, WALKIN_HEARD_FROM), marketingOptIn: v.marketingOptIn,
    waiverSignedAt: isoOrNull(v.waiverSignedAt), version: integer(v.version, 1, 999_999_999),
  };
}
function settings(value: unknown): WalkInSettings {
  const s = object(value, ['enabled', 'waiver', 'waiverVersion', 'emergencyRequired', 'pipelineId', 'pipelineStageId', 'offers', 'thankYou', 'version', 'updatedAt']);
  const input = validateWalkInSettingsInput({ expectedVersion: 0, enabled: s.enabled, waiver: s.waiver, emergencyRequired: s.emergencyRequired, pipelineId: s.pipelineId,
    pipelineStageId: s.pipelineStageId, offers: s.offers, thankYou: s.thankYou });
  const { expectedVersion: _ignored, ...rest } = input;
  return { ...rest, waiverVersion: integer(s.waiverVersion, 1, 999_999_999), version: integer(s.version, 1, 999_999_999), updatedAt: iso(s.updatedAt) };
}
export function verifyWalkInOverview(value: unknown): WalkInOverview {
  const o = object(value, ['canManage', 'configured', 'enabled', 'devices', 'visits']);
  if (typeof o.canManage !== 'boolean' || typeof o.configured !== 'boolean' || typeof o.enabled !== 'boolean' || !Array.isArray(o.devices) || !Array.isArray(o.visits)) fail();
  return { canManage: o.canManage, configured: o.configured, enabled: o.enabled, devices: o.devices.map(device), visits: o.visits.map(visit) };
}
export function verifyWalkInSettingsRead(value: unknown): WalkInSettingsRead {
  const o = object(value, ['settings', 'pipelines']);
  if (!Array.isArray(o.pipelines)) fail();
  return { settings: o.settings === null ? null : settings(o.settings), pipelines: o.pipelines.map(entry => {
    const p = object(entry, ['pipelineId', 'name', 'stages']);
    if (typeof p.name !== 'string' || !Array.isArray(p.stages)) fail();
    return { pipelineId: uuid(p.pipelineId), name: p.name, stages: p.stages.map(stage => {
      const s = object(stage, ['stageId', 'name']);
      if (typeof s.name !== 'string') fail();
      return { stageId: uuid(s.stageId), name: s.name };
    }) };
  }) };
}
export function verifyWalkInSettingsReceipt(value: unknown): { settings: WalkInSettings } { return { settings: settings(object(value, ['settings']).settings) }; }
export function verifyWalkInDeviceReceipt(value: unknown, expected: { deviceId?: string } = {}): { device: WalkInDevice } {
  const d = device(object(value, ['device']).device);
  if (expected.deviceId && d.deviceId !== expected.deviceId) fail();
  return { device: d };
}
export function verifyWalkInVisitReceipt(value: unknown, expected: { visitId: string }): { visit: WalkInVisit } {
  const v = visit(object(value, ['visit']).visit);
  if (v.visitId !== expected.visitId) fail();
  return { visit: v };
}
export function verifyWalkInVisitDetail(value: unknown, visitId: string): WalkInVisitDetail {
  const o = object(value, ['visit', 'waiver']);
  const v = visit(o.visit);
  if (v.visitId !== visitId) fail();
  const w = object(o.waiver, ['version', 'language', 'text', 'textHash', 'signerName', 'relationship', 'strokes', 'signedAt']);
  if (typeof w.text !== 'string' || typeof w.textHash !== 'string' || !/^[a-f0-9]{64}$/.test(w.textHash) || typeof w.signerName !== 'string') fail();
  return { visit: v, waiver: { version: integer(w.version, 1, 999_999_999), language: oneOf(w.language, WALKIN_LANGUAGES), text: w.text, textHash: w.textHash,
    signerName: w.signerName, relationship: oneOf(w.relationship, WALKIN_SIGNER_RELATIONSHIPS), strokes: validateWalkInStrokes(w.strokes), signedAt: iso(w.signedAt) } };
}
export function verifyWalkInTerminal(value: unknown): WalkInTerminal {
  const t = object(value, ['schoolName', 'branding', 'endsAt', 'settingsVersion', 'waiver', 'emergencyRequired', 'offers', 'thankYou']);
  const b = object(t.branding, ['logoUrl', 'accentColor']);
  if (typeof t.schoolName !== 'string' || typeof t.emergencyRequired !== 'boolean' || !Array.isArray(t.offers)) fail();
  const offers = validateWalkInSettingsInput({ expectedVersion: 0, enabled: true, waiver: t.waiver, emergencyRequired: t.emergencyRequired,
    pipelineId: '00000000-0000-4000-8000-000000000000', pipelineStageId: '00000000-0000-4000-8000-000000000000',
    offers: (t.offers as unknown[]).map(entry => { const { currency, ...rest } = object(entry, ['key', 'kind', 'name', 'description', 'priceMinor', 'currency']); if (currency !== 'USD') fail(); return rest; }),
    thankYou: t.thankYou });
  return { schoolName: t.schoolName, branding: { logoUrl: typeof b.logoUrl === 'string' ? b.logoUrl : null, accentColor: typeof b.accentColor === 'string' ? b.accentColor : null },
    endsAt: iso(t.endsAt), settingsVersion: integer(t.settingsVersion, 1, 999_999_999), waiver: offers.waiver, emergencyRequired: t.emergencyRequired,
    offers: offers.offers.map(o => ({ ...o, currency: 'USD' as const })), thankYou: offers.thankYou };
}
export function verifyWalkInVisitOutcome(value: unknown): WalkInVisitOutcome {
  const o = object(value, ['result'], ['firstName', 'paymentState', 'priceMinor', 'thankYou']);
  const result = oneOf(o.result, WALKIN_VISIT_RESULTS);
  if (result !== 'RECORDED') { if (Object.keys(o).length !== 1) fail(); return { result }; }
  if (typeof o.firstName !== 'string' || (o.thankYou !== null && typeof o.thankYou !== 'string')) fail();
  return { result, firstName: o.firstName, paymentState: oneOf(o.paymentState, WALKIN_PAYMENT_STATES), priceMinor: integer(o.priceMinor, 0, WALKIN_LIMITS.maxPriceMinor),
    thankYou: (o.thankYou as string | null) ?? null };
}
/** A text in the chosen language, falling back to English (and saying so through `fallback`). */
export function walkInText(value: WalkInText, language: WalkInLanguage): { text: string; fallback: boolean } {
  const chosen = value[language];
  return chosen ? { text: chosen, fallback: false } : { text: value.en, fallback: language !== 'en' };
}
