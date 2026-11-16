import { CA_REGIONS, US_REGIONS, validateSchoolLocationInput, type SaveSchoolLocationInput, type SchoolLocation, type SchoolLocationInput } from '@hon/contracts';
import type { LocationCopy } from './copy';

/** What staff type: every field as text; an empty optional field means "not set". */
export type LocationDraft = Readonly<{ country: string; region: string; city: string; postalCode: string; addressLine1: string; addressLine2: string }>;
export type LocationField = keyof LocationDraft;
export const LOCATION_FIELDS: readonly LocationField[] = ['country', 'region', 'city', 'postalCode', 'addressLine1', 'addressLine2'];
export const EMPTY_LOCATION_DRAFT: LocationDraft = Object.freeze({ country: '', region: '', city: '', postalCode: '', addressLine1: '', addressLine2: '' });

/** The regions offered for a country: the closed US and Canada lists, nothing elsewhere. */
export function regionsFor(country: string): readonly string[] { return country === 'US' ? US_REGIONS : country === 'CA' ? CA_REGIONS : []; }

export function draftFrom(location: SchoolLocation | SchoolLocationInput | null): LocationDraft {
  if (!location) return EMPTY_LOCATION_DRAFT;
  return { country: location.country, region: location.region ?? '', city: location.city, postalCode: location.postalCode ?? '',
    addressLine1: location.addressLine1 ?? '', addressLine2: location.addressLine2 ?? '' };
}
/** Trim the edges and collapse inner runs of spaces; a region only exists where the country has a list. */
export function locationFrom(draft: LocationDraft): SchoolLocationInput {
  const t = (v: string) => { const x = v.trim().replace(/\s+/g, ' '); return x === '' ? null : x; };
  return { country: draft.country, region: regionsFor(draft.country).length ? t(draft.region) : null, city: t(draft.city) ?? '',
    postalCode: t(draft.postalCode), addressLine1: t(draft.addressLine1), addressLine2: t(draft.addressLine2) };
}
export function sameDraft(a: LocationDraft, b: LocationDraft): boolean { return LOCATION_FIELDS.every(f => a[f] === b[f]); }

const UNSAFE = /[<>]/;
/** Plain-language problems that stop a save; the server checks the same rules again. */
export function draftProblems(draft: LocationDraft, c: LocationCopy): string[] {
  const v = locationFrom(draft), p: string[] = [];
  if (!/^[A-Z]{2}$/.test(v.country)) p.push(c.problems.country);
  else if (regionsFor(v.country).length && !(v.region && regionsFor(v.country).includes(v.region))) p.push(c.problems.region);
  if (!v.city || v.city.length > 100 || UNSAFE.test(v.city)) p.push(c.problems.city);
  if (v.postalCode && (v.postalCode.length > 20 || UNSAFE.test(v.postalCode))) p.push(c.problems.postalCode);
  if (v.addressLine1 && (v.addressLine1.length > 200 || UNSAFE.test(v.addressLine1))) p.push(c.problems.addressLine1);
  if (v.addressLine2 && (!v.addressLine1 || v.addressLine2.length > 200 || UNSAFE.test(v.addressLine2))) p.push(c.problems.addressLine2);
  if (p.length === 0) { try { validateSchoolLocationInput(v); } catch { p.push(c.problems.city); } }
  return p;
}
/** The location to send, or null when the draft cannot be sent. */
export function draftLocation(draft: LocationDraft, c: LocationCopy): SchoolLocationInput | null {
  if (draftProblems(draft, c).length) return null;
  try { return validateSchoolLocationInput(locationFrom(draft)); } catch { return null; }
}
export function saveInput(read: SchoolLocation | null, draft: LocationDraft, c: LocationCopy): SaveSchoolLocationInput {
  const location = draftLocation(draft, c);
  if (!location) throw new Error('invalid');
  return { location, expectedVersion: read?.version ?? 0 };
}
