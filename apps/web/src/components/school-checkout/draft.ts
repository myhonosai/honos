import {
  CHECKOUT_LANGUAGES, CHECKOUT_LIMITS, EMPTY_CHECKOUT_CONTENT, checkoutTextOk, validateCheckoutContent,
  type CheckoutContent, type CheckoutFieldKind, type CheckoutLanguage, type CheckoutPage, type CheckoutPageKind, type CheckoutPlanChoice, type CheckoutText,
} from '@hon/contracts';

/**
 * The editable form of one checkout page (B-TUI-2 piece 9b over 0269). Every text holds all three languages as plain strings;
 * an empty Korean or Spanish text is left out when saved, so the family page falls back to English. Amounts are typed as
 * dollars and cents. Nothing here talks to the network: these are pure steps the page and its tests share.
 */
export type TextDraft = Readonly<Record<CheckoutLanguage, string>>;
export type AddOnDraft = Readonly<{ key: string; label: TextDraft; amount: string; currency: string; required: boolean }>;
export type FieldDraft = Readonly<{ key: string; label: TextDraft; kind: CheckoutFieldKind; required: boolean; options: readonly TextDraft[] }>;
export type CheckoutDraft = Readonly<{
  planIds: readonly string[]; addOns: readonly AddOnDraft[]; customFields: readonly FieldDraft[];
  waiverOn: boolean; waiver: TextDraft; receiptNote: TextDraft; thankYou: TextDraft;
}>;

export const EMPTY_TEXT: TextDraft = Object.freeze({ en: '', ko: '', es: '' });
const AMOUNT = /^(\d{1,6})(?:\.(\d{1,2}))?$/;
const textDraft = (value: CheckoutText | null | undefined): TextDraft => ({ en: value?.en ?? '', ko: value?.ko ?? '', es: value?.es ?? '' });
const money = (minor: number) => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;

/** The draft for a saved page, or an empty one when the school has not saved this kind yet. */
export function draftFrom(page: CheckoutPage | null): CheckoutDraft {
  const c = page?.content ?? EMPTY_CHECKOUT_CONTENT;
  return {
    planIds: [...c.planIds],
    addOns: c.addOns.map((a) => ({ key: a.key, label: textDraft(a.label), amount: money(a.amountMinor), currency: a.currency, required: a.required })),
    customFields: c.customFields.map((f) => ({ key: f.key, label: textDraft(f.label), kind: f.kind, required: f.required, options: f.options.map(textDraft) })),
    waiverOn: c.waiver !== null, waiver: textDraft(c.waiver?.text), receiptNote: textDraft(c.receiptNote), thankYou: textDraft(c.thankYou),
  };
}

/** Dollars and cents typed by staff, as minor units; null when it is not a plain amount between 0.01 and 999,999.99. */
export function amountMinor(value: string): number | null {
  const m = AMOUNT.exec(value.trim().replace(/^\$/, ''));
  if (!m) return null;
  const minor = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return minor >= 1 && minor <= 99_999_999 ? minor : null;
}

/** One line: spaces collapsed. Several lines: Windows line ends and trailing spaces removed. Both trimmed. */
export function cleanText(value: string, multiline: boolean): string {
  return multiline
    ? value.replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/[ \t]+$/g, '')).join('\n').trim()
    : value.replace(/\s+/g, ' ').trim();
}
function translated(text: TextDraft, multiline: boolean): CheckoutText {
  const out: CheckoutText = { en: cleanText(text.en, multiline) };
  for (const language of ['ko', 'es'] as const) { const v = cleanText(text[language], multiline); if (v) out[language] = v; }
  return out;
}
const blank = (text: TextDraft) => CHECKOUT_LANGUAGES.every((l) => cleanText(text[l], true) === '');

/** A new key for an add-on or question: the first free one of prefix_1, prefix_2, … */
export function nextKey(prefix: 'addon' | 'question', taken: readonly string[]): string {
  for (let n = 1; ; n++) if (!taken.includes(`${prefix}_${n}`)) return `${prefix}_${n}`;
}

/** What staff must fix before this draft can be saved, in plain words. Empty when it can be sent. */
export function draftProblems(draft: CheckoutDraft, kind: CheckoutPageKind, publish: boolean, plans: readonly CheckoutPlanChoice[]): string[] {
  const problems: string[] = [];
  const text = (t: TextDraft, max: number, multiline: boolean, what: string) => {
    for (const language of CHECKOUT_LANGUAGES) {
      const v = cleanText(t[language], multiline);
      if (language === 'en' && v === '') { problems.push(`${what} needs English text.`); continue; }
      if (v !== '' && !checkoutTextOk(v, max, multiline)) problems.push(`${what} (${language === 'en' ? 'English' : language === 'ko' ? 'Korean' : 'Spanish'}) must be at most ${max} characters, without < or >.`);
    }
  };
  if (draft.planIds.length > CHECKOUT_LIMITS.plans) problems.push(`Show at most ${CHECKOUT_LIMITS.plans} plans.`);
  for (const planId of draft.planIds) {
    const plan = plans.find((p) => p.planId === planId);
    if (!plan || !plan.available) problems.push(`${plan ? plan.displayName : 'A plan'} is no longer available. Remove it from this page.`);
  }
  if (kind === 'ENROLLMENT' && publish && draft.planIds.length === 0) problems.push('Choose at least one plan before publishing the enrollment page.');
  if (draft.addOns.length > CHECKOUT_LIMITS.addOns) problems.push(`Use at most ${CHECKOUT_LIMITS.addOns} add-ons.`);
  draft.addOns.forEach((a, i) => {
    text(a.label, CHECKOUT_LIMITS.label, false, `Add-on ${i + 1} name`);
    if (amountMinor(a.amount) === null) problems.push(`Add-on ${i + 1} needs an amount like 25 or 25.00.`);
  });
  if (draft.customFields.length > CHECKOUT_LIMITS.fields) problems.push(`Use at most ${CHECKOUT_LIMITS.fields} questions.`);
  draft.customFields.forEach((f, i) => {
    text(f.label, CHECKOUT_LIMITS.question, false, `Question ${i + 1}`);
    if (f.kind === 'CHOICE') {
      if (f.options.length < 2 || f.options.length > CHECKOUT_LIMITS.choiceOptions) problems.push(`Question ${i + 1} needs 2 to ${CHECKOUT_LIMITS.choiceOptions} choices.`);
      f.options.forEach((o, j) => text(o, CHECKOUT_LIMITS.label, false, `Question ${i + 1} choice ${j + 1}`));
    }
  });
  if (draft.waiverOn) text(draft.waiver, CHECKOUT_LIMITS.waiver, true, 'The waiver');
  if (!blank(draft.receiptNote)) text(draft.receiptNote, CHECKOUT_LIMITS.note, true, 'The receipt note');
  if (!blank(draft.thankYou)) text(draft.thankYou, CHECKOUT_LIMITS.note, true, 'The thank-you message');
  return problems;
}

/** The content to send. It throws when the draft is not acceptable; the contract validator is the final word. */
export function contentFrom(draft: CheckoutDraft): CheckoutContent {
  return validateCheckoutContent({
    planIds: [...draft.planIds],
    addOns: draft.addOns.map((a) => ({ key: a.key, label: translated(a.label, false), amountMinor: amountMinor(a.amount), currency: a.currency, required: a.required })),
    customFields: draft.customFields.map((f) => ({ key: f.key, label: translated(f.label, false), kind: f.kind, required: f.required,
      options: f.kind === 'CHOICE' ? f.options.map((o) => translated(o, false)) : [] })),
    waiver: draft.waiverOn ? { text: translated(draft.waiver, true) } : null,
    receiptNote: blank(draft.receiptNote) ? null : translated(draft.receiptNote, true),
    thankYou: blank(draft.thankYou) ? null : translated(draft.thankYou, true),
  });
}

/** Every edit the page offers, as one pure step on the draft. */
export type DraftEdit =
  | { type: 'plan'; planId: string; shown: boolean } | { type: 'planMove'; planId: string; by: -1 | 1 }
  | { type: 'addAddOn'; currency: string } | { type: 'addOn'; index: number; patch: Partial<Omit<AddOnDraft, 'key'>> } | { type: 'removeAddOn'; index: number }
  | { type: 'addField' } | { type: 'field'; index: number; patch: Partial<Omit<FieldDraft, 'key' | 'options'>> } | { type: 'removeField'; index: number }
  | { type: 'addOption'; index: number } | { type: 'option'; index: number; option: number; text: TextDraft } | { type: 'removeOption'; index: number; option: number }
  | { type: 'waiverOn'; on: boolean } | { type: 'text'; target: 'waiver' | 'receiptNote' | 'thankYou'; text: TextDraft };

const at = <T>(list: readonly T[], index: number, next: (item: T) => T): T[] => list.map((item, i) => i === index ? next(item) : item);
export function editDraft(draft: CheckoutDraft, edit: DraftEdit): CheckoutDraft {
  switch (edit.type) {
    case 'plan': {
      const without = draft.planIds.filter((id) => id !== edit.planId);
      return { ...draft, planIds: edit.shown ? [...without, edit.planId] : without };
    }
    case 'planMove': {
      const from = draft.planIds.indexOf(edit.planId), to = from + edit.by;
      if (from < 0 || to < 0 || to >= draft.planIds.length) return draft;
      const ids = [...draft.planIds]; [ids[from], ids[to]] = [ids[to] as string, ids[from] as string];
      return { ...draft, planIds: ids };
    }
    case 'addAddOn': return { ...draft, addOns: [...draft.addOns, { key: nextKey('addon', draft.addOns.map((a) => a.key)), label: EMPTY_TEXT, amount: '', currency: edit.currency, required: false }] };
    case 'addOn': return { ...draft, addOns: at(draft.addOns, edit.index, (a) => ({ ...a, ...edit.patch })) };
    case 'removeAddOn': return { ...draft, addOns: draft.addOns.filter((_, i) => i !== edit.index) };
    case 'addField': return { ...draft, customFields: [...draft.customFields, { key: nextKey('question', draft.customFields.map((f) => f.key)), label: EMPTY_TEXT, kind: 'TEXT', required: false, options: [] }] };
    case 'field': return { ...draft, customFields: at(draft.customFields, edit.index, (f) => {
      const next = { ...f, ...edit.patch };
      // A choice question starts with two empty choices; other kinds have none.
      return { ...next, options: next.kind === 'CHOICE' ? (f.kind === 'CHOICE' ? f.options : [EMPTY_TEXT, EMPTY_TEXT]) : [] };
    }) };
    case 'removeField': return { ...draft, customFields: draft.customFields.filter((_, i) => i !== edit.index) };
    case 'addOption': return { ...draft, customFields: at(draft.customFields, edit.index, (f) => ({ ...f, options: [...f.options, EMPTY_TEXT] })) };
    case 'option': return { ...draft, customFields: at(draft.customFields, edit.index, (f) => ({ ...f, options: at(f.options, edit.option, () => edit.text) })) };
    case 'removeOption': return { ...draft, customFields: at(draft.customFields, edit.index, (f) => ({ ...f, options: f.options.filter((_, j) => j !== edit.option) })) };
    case 'waiverOn': return { ...draft, waiverOn: edit.on };
    case 'text': return { ...draft, [edit.target]: edit.text };
  }
}
