// School number orders (0352): a school owner picks a US local number in HON, a human HON HQ owner approves it, and the
// purchase worker buys it on the school's own Twilio subaccount. The school pays only for the number; texting is
// included (owner, 2026-11-14). The monthly price shown is Twilio's quote at order time; nothing is charged here.

export const SCHOOL_NUMBER_ORDER_STATUSES = ['REQUESTED', 'APPROVED', 'PURCHASING', 'PURCHASED', 'FAILED', 'REJECTED', 'CANCELLED'] as const;
export type SchoolNumberOrderStatus = typeof SCHOOL_NUMBER_ORDER_STATUSES[number];
export const SCHOOL_NUMBER_ORDER_COMMAND = 'communication.number.order';
export const SCHOOL_NUMBER_CANCEL_COMMAND = 'communication.number.cancel';

export interface AvailableSchoolNumber { phoneE164: string; locality: string | null; region: string | null; monthlyPriceMicrounits: number }
export interface SchoolNumberOrder {
  orderId: string; schoolId: string; phoneE164: string; locality: string | null; region: string | null; monthlyPriceMicrounits: number;
  status: SchoolNumberOrderStatus; decisionNote: string | null; decidedAt: string | null; failureCode: string | null; version: number;
  createdAt: string; updatedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NANP = /^\+1[2-9][0-9]{9}$/;
const KEYS = ['orderId', 'schoolId', 'phoneE164', 'locality', 'region', 'monthlyPriceMicrounits', 'status', 'decisionNote', 'decidedAt',
  'failureCode', 'version', 'createdAt', 'updatedAt'].sort().join(',');
const nullableString = (value: unknown) => value === null || typeof value === 'string';

/** Strict shape check of one order as the database returns it; anything else is refused. */
export function verifySchoolNumberOrder(value: unknown): SchoolNumberOrder {
  const o = value as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).sort().join(',') !== KEYS
    || typeof o.orderId !== 'string' || !UUID.test(o.orderId) || typeof o.schoolId !== 'string' || !UUID.test(o.schoolId)
    || typeof o.phoneE164 !== 'string' || !NANP.test(o.phoneE164) || !nullableString(o.locality) || !nullableString(o.region)
    || !Number.isSafeInteger(o.monthlyPriceMicrounits) || (o.monthlyPriceMicrounits as number) < 0
    || !SCHOOL_NUMBER_ORDER_STATUSES.includes(o.status as SchoolNumberOrderStatus)
    || !nullableString(o.decisionNote) || !nullableString(o.decidedAt) || !nullableString(o.failureCode)
    || !Number.isSafeInteger(o.version) || (o.version as number) < 1 || typeof o.createdAt !== 'string' || typeof o.updatedAt !== 'string') {
    throw new Error('Unverified school number order.');
  }
  return o as unknown as SchoolNumberOrder;
}

export function verifySchoolNumberOrderList(value: unknown): SchoolNumberOrder[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error('Unverified school number order list.');
  return value.map(verifySchoolNumberOrder);
}

/** Search input: a 3-digit area code, or a city with a 2-letter state. Exactly one of the two. */
export type SchoolNumberSearch = { areaCode: string } | { city: string; region: string };
export function validateSchoolNumberSearch(query: Record<string, unknown>): SchoolNumberSearch {
  const keys = Object.keys(query).sort().join(',');
  if (keys === 'areaCode' && typeof query.areaCode === 'string' && /^[2-9][0-9]{2}$/.test(query.areaCode)) return { areaCode: query.areaCode };
  if (keys === 'city,region' && typeof query.city === 'string' && /^[A-Za-z][A-Za-z .'-]{1,59}$/.test(query.city)
    && typeof query.region === 'string' && /^[A-Z]{2}$/.test(query.region)) return { city: query.city.trim(), region: query.region };
  throw new Error('INVALID_NUMBER_SEARCH');
}
