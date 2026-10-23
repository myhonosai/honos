/** Browser-only design state. NOT an API contract, SKU, offer identity, permission or published price. */
export const DESIGN_OFFER_LAYOUTS = ['monthly', 'annual', 'founder-monthly', 'founder-annual', 'lifetime', 'founder-lifetime'] as const;
export type DesignOfferLayout = typeof DESIGN_OFFER_LAYOUTS[number];
export type OfferDesign = {
  layout: DesignOfferLayout; name: string; amount: string; currency: string; eligibility: string; terms: string;
  saleStart: string; saleEnd: string; founderLimit: string; annualDiscount: string; renewal: string;
  serviceTerms: string; fairUse: string; credits: string; usageLimits: string;
};
export const isFounderDesign = (layout: DesignOfferLayout) => layout.startsWith('founder-');
export const isLifetimeDesign = (layout: DesignOfferLayout) => layout.endsWith('lifetime');
export const isAnnualDesign = (layout: DesignOfferLayout) => layout.endsWith('annual');
export function emptyOfferDesign(layout: DesignOfferLayout): OfferDesign {
  return { layout, name: 'HON OS', amount: '', currency: 'USD', eligibility: '', terms: '', saleStart: '', saleEnd: '', founderLimit: '', annualDiscount: '', renewal: '', serviceTerms: '', fairUse: '', credits: '', usageLimits: '' };
}
/** Preview formatting only. Reject precision loss instead of silently rounding a draft price. */
export function designPrice(amount: string, currency: string, locale = 'en-US'): string | null {
  if (!/^[A-Z]{3}$/.test(currency) || !/^\d{1,9}(?:\.\d{1,3})?$/.test(amount)) return null;
  try {
    const format = new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'code' });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    if ((amount.split('.')[1]?.length ?? 0) > digits || Number(amount) <= 0) return null;
    return format.format(Number(amount));
  } catch { return null; }
}
export type DesignProblem = 'price' | 'terms' | 'eligibility' | 'founder' | 'annual' | 'renewal' | 'lifetime' | 'usage' | 'dates';
export function designProblems(draft: OfferDesign): DesignProblem[] {
  const problems: DesignProblem[] = [];
  if (!designPrice(draft.amount, draft.currency)) problems.push('price');
  if (!draft.name.trim() || !draft.terms.trim()) problems.push('terms');
  if (isFounderDesign(draft.layout) && !draft.eligibility.trim()) problems.push('eligibility');
  if (isFounderDesign(draft.layout) && !/^[1-9]\d{0,5}$/.test(draft.founderLimit)) problems.push('founder');
  if (isAnnualDesign(draft.layout) && draft.annualDiscount !== '' && (!/^\d{1,2}(?:\.\d{1,2})?$/.test(draft.annualDiscount) || Number(draft.annualDiscount) >= 100)) problems.push('annual');
  if (!isLifetimeDesign(draft.layout) && !draft.renewal.trim()) problems.push('renewal');
  if (isLifetimeDesign(draft.layout) && (!draft.serviceTerms.trim() || !draft.fairUse.trim())) problems.push('lifetime');
  if (!/^\d{1,8}$/.test(draft.credits) || !draft.usageLimits.trim()) problems.push('usage');
  for (const value of [draft.saleStart, draft.saleEnd]) if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value)) { problems.push('dates'); break; }
  if (draft.saleStart && draft.saleEnd && draft.saleEnd < draft.saleStart && !problems.includes('dates')) problems.push('dates');
  return problems;
}
/** Founder previews require backend eligibility AND publication. Neither exists in this design-only milestone. */
export function customerDesignVisible(draft: OfferDesign): boolean { return !isFounderDesign(draft.layout); }
