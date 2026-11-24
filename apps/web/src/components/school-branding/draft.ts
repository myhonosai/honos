import {
  SCHOOL_BRANDING_LIMITS, schoolBrandingColorOk, schoolBrandingContactLineOk, schoolBrandingImageUrlOk,
  type SaveSchoolBrandingInput, type SchoolBranding, type SchoolBrandingInput,
} from '@hon/contracts';

/** What staff type: every field as text; an empty field means "not set". */
export type BrandingDraft = Readonly<{ logoUrl: string; coverUrl: string; accentColor: string; contactLine: string }>;
export type BrandingField = keyof BrandingDraft;
export const BRANDING_FIELDS: readonly BrandingField[] = ['logoUrl', 'coverUrl', 'accentColor', 'contactLine'];

export function draftFrom(branding: SchoolBranding | SchoolBrandingInput): BrandingDraft {
  return { logoUrl: branding.logoUrl ?? '', coverUrl: branding.coverUrl ?? '', accentColor: branding.accentColor ?? '', contactLine: branding.contactLine ?? '' };
}
/** Trim the edges; a color picker answers lower-case already, but a typed color is folded to lower case. */
export function brandingFrom(draft: BrandingDraft): SchoolBrandingInput {
  const t = (v: string) => { const x = v.trim(); return x === '' ? null : x; };
  const color = t(draft.accentColor);
  return { logoUrl: t(draft.logoUrl), coverUrl: t(draft.coverUrl), accentColor: color === null ? null : color.toLowerCase(), contactLine: t(draft.contactLine) };
}
export function sameDraft(a: BrandingDraft, b: BrandingDraft): boolean { return BRANDING_FIELDS.every((f) => a[f] === b[f]); }

// Plain predicates (not type guards), so a refused value keeps its string type for the message.
const urlOk: (v: string) => boolean = schoolBrandingImageUrlOk, lineOk: (v: string) => boolean = schoolBrandingContactLineOk;

/** Plain-language problems that stop a save; the server checks the same rules again. */
export function draftProblems(draft: BrandingDraft): string[] {
  const value = brandingFrom(draft), problems: string[] = [];
  const image = (v: string | null, name: string) => {
    if (v === null || urlOk(v)) return;
    problems.push(v.length > SCHOOL_BRANDING_LIMITS.imageUrl ? `The ${name} link is too long (at most ${SCHOOL_BRANDING_LIMITS.imageUrl} characters).`
      : `The ${name} link must be a full https:// address of an image, with a lower-case website name and no spaces or quotes.`);
  };
  image(value.logoUrl, 'logo'); image(value.coverUrl, 'cover photo');
  if (value.accentColor !== null && !schoolBrandingColorOk(value.accentColor)) problems.push('The color must look like #c81e1e (a # and six digits or letters a to f).');
  if (value.contactLine !== null && !lineOk(value.contactLine)) {
    problems.push(value.contactLine.length > SCHOOL_BRANDING_LIMITS.contactLine ? `The contact line is too long (at most ${SCHOOL_BRANDING_LIMITS.contactLine} characters).`
      : 'The contact line must be one line without < or > characters.');
  }
  return problems;
}

/** The save request from the last verified read and the staff draft; it throws when the draft cannot be sent. */
export function saveInput(read: SchoolBranding, draft: BrandingDraft): SaveSchoolBrandingInput {
  if (draftProblems(draft).length > 0) throw new Error('invalid');
  return { branding: brandingFrom(draft), expectedVersion: read.version };
}
