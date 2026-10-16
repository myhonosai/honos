export interface ParentClassPassList<T> { items: T[]; limited: boolean }
export interface ParentClassPassBooking {
  startsAt: string;
  bookingStatus: 'BOOKED' | 'WAITLISTED' | 'CANCELLED' | 'CHECKED_IN' | 'NO_SHOW';
  redemptionOutcome: 'REDEEMED' | 'NOT_REDEEMED' | 'REVERSED';
  attendanceState: 'NOT_RECORDED' | 'PRESENT' | 'LATE' | 'EXCUSED_ABSENCE' | 'UNEXCUSED_ABSENCE' | 'MAKEUP';
}
export interface ParentClassPass {
  productDisplayName: string; remainingUses: number; expiresAt: string;
  status: 'ACTIVE' | 'EXHAUSTED' | 'REVERSED' | 'EXPIRED';
  bookings: ParentClassPassList<ParentClassPassBooking>;
}
export interface ParentClassPassView {
  generatedAt: string; accessLevel: 'PRIMARY_GUARDIAN' | 'SECONDARY_GUARDIAN';
  paymentProviderOutcome: 'UNAVAILABLE';
  children: ParentClassPassList<{ displayName: string; passes: ParentClassPassList<ParentClassPass> }>;
}
const invalid = (): never => { throw new Error('Parent ClassPass response could not be verified.'); };
function object(v: unknown, keys: string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) invalid();
  const o = v as Record<string, unknown>;
  if (Object.keys(o).length !== keys.length || keys.some(k => !Object.hasOwn(o, k))) invalid();
  return o;
}
function text(v: unknown, max: number): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\x00-\x1f\x7f-\x9f]/.test(v)) invalid();
  return v as string;
}
function timestamp(v: unknown): string {
  const s = text(v, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(s) || !Number.isFinite(Date.parse(s))
    || new Date(s.slice(0, 10)).toISOString().slice(0, 10) !== s.slice(0, 10)
    || Number(s.slice(11, 13)) > 23 || Number(s.slice(14, 16)) > 59 || Number(s.slice(17, 19)) > 59) invalid();
  return new Date(s).toISOString();
}
function value<const T extends readonly string[]>(v: unknown, options: T): T[number] {
  if (typeof v !== 'string' || !options.includes(v)) invalid(); return v as T[number];
}
function list<T>(v: unknown, max: number, verify: (v: unknown) => T): ParentClassPassList<T> {
  const o = object(v, ['items', 'limited']);
  if (!Array.isArray(o.items) || o.items.length > max || typeof o.limited !== 'boolean') invalid();
  return { items: (o.items as unknown[]).map(verify), limited: o.limited as boolean };
}
function booking(v: unknown): ParentClassPassBooking {
  const o = object(v, ['startsAt', 'bookingStatus', 'redemptionOutcome', 'attendanceState']);
  return { startsAt: timestamp(o.startsAt), bookingStatus: value(o.bookingStatus, ['BOOKED','WAITLISTED','CANCELLED','CHECKED_IN','NO_SHOW']),
    redemptionOutcome: value(o.redemptionOutcome, ['REDEEMED','NOT_REDEEMED','REVERSED']),
    attendanceState: value(o.attendanceState, ['NOT_RECORDED','PRESENT','LATE','EXCUSED_ABSENCE','UNEXCUSED_ABSENCE','MAKEUP']) };
}
function pass(v: unknown): ParentClassPass {
  const o = object(v, ['productDisplayName','remainingUses','expiresAt','status','bookings']);
  if (!Number.isSafeInteger(o.remainingUses) || Number(o.remainingUses) < 0 || Number(o.remainingUses) > 1000) invalid();
  const status = value(o.status, ['ACTIVE','EXHAUSTED','REVERSED','EXPIRED']);
  if ((status === 'ACTIVE' && o.remainingUses === 0) || (['EXHAUSTED','REVERSED'].includes(status) && o.remainingUses !== 0)) invalid();
  return { productDisplayName: text(o.productDisplayName, 100), remainingUses: o.remainingUses as number, expiresAt: timestamp(o.expiresAt), status, bookings: list(o.bookings, 10, booking) };
}
/** Fixed schema rejects raw IDs, roster/staff facts, financial fields and inferred provider success. */
export function verifyParentClassPassView(v: unknown): ParentClassPassView {
  const o = object(v, ['generatedAt','accessLevel','paymentProviderOutcome','children']);
  return { generatedAt: timestamp(o.generatedAt), accessLevel: value(o.accessLevel, ['PRIMARY_GUARDIAN','SECONDARY_GUARDIAN']),
    paymentProviderOutcome: value(o.paymentProviderOutcome, ['UNAVAILABLE']),
    children: list(o.children, 20, c => { const child = object(c, ['displayName','passes']); return { displayName: text(child.displayName, 400), passes: list(child.passes, 20, pass) }; }) };
}
