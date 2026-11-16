import {
  CHECKOUT_LANGUAGES, CHECKOUT_LIMITS, checkoutDateOk, checkoutSlugOk, checkoutTextOk, validateCheckoutContent,
  type CheckoutBilling, type CheckoutBlockPosition, type CheckoutCollectionMethod, type CheckoutContent, type CheckoutFieldKind, type CheckoutLanguage,
  type CheckoutOption, type CheckoutPage, type CheckoutPageStatus, type CheckoutPlanChoice, type CheckoutText, type SaveCheckoutPageInput,
} from '@hon/contracts';
import { amountToMinor, formatMinor, minorToAmountText } from '../invoice-pickers';

/**
 * The editable form of one checkout page (checkout CP2 over 0402), modeled on the owner's current CRM editor: page details,
 * pricing options and the agreement. Every text holds all three languages as plain strings; an empty Korean or Spanish
 * text is left out when saved, so families see English. Amounts are typed in the currency's own units. Nothing here
 * talks to the network: these are pure steps the page and its tests share.
 */
export type TextDraft = Readonly<Record<CheckoutLanguage, string>>;
export type AddOnDraft = Readonly<{ key: string; label: TextDraft; amount: string; required: boolean }>;
export type FieldDraft = Readonly<{ key: string; label: TextDraft; kind: CheckoutFieldKind; required: boolean; options: readonly TextDraft[] }>;
export type BlockDraft = Readonly<{ position: CheckoutBlockPosition; text: TextDraft }>;
export type OptionDraft = Readonly<{
  key: string; label: TextDraft; description: TextDraft; planId: string | null; billing: CheckoutBilling;
  /** One-time price; "0" is allowed (a free trial). */ price: string;
  /** Monthly amount. */ recurring: string; /** Number of monthly payments; "0" means ongoing. */ installments: string;
  downOn: boolean; down: string; downLabel: TextDraft; collectionMethod: CheckoutCollectionMethod;
  /** Blank charges the full price for every extra participant. */ extraParticipant: string;
  /** "0" means unlimited. */ capacity: string; availableThrough: string; mostPopular: boolean; createsMembership: boolean;
}>;
export type PageDraft = Readonly<{
  pageId: string | null; version: number; slug: string; groupKey: string; currency: string;
  title: TextDraft; description: TextDraft; blocks: readonly BlockDraft[]; multiOn: boolean; maxPerOrder: string;
  customFields: readonly FieldDraft[]; addOns: readonly AddOnDraft[]; options: readonly OptionDraft[];
  waiverOn: boolean; waiver: TextDraft; receiptNote: TextDraft; thankYou: TextDraft;
}>;

export const EMPTY_TEXT: TextDraft = Object.freeze({ en: '', ko: '', es: '' });
const textDraft = (value: CheckoutText | null | undefined): TextDraft => ({ en: value?.en ?? '', ko: value?.ko ?? '', es: value?.es ?? '' });
const english = (en: string): TextDraft => ({ en, ko: '', es: '' });
const amountText = (minor: number | null | undefined, currency: string) => minor === null || minor === undefined ? '' : minorToAmountText(minor, currency);

function optionDraft(o: CheckoutOption, currency: string): OptionDraft {
  return {
    key: o.key, label: textDraft(o.label), description: textDraft(o.description), planId: o.planId, billing: o.billing,
    price: amountText(o.priceMinor, currency), recurring: amountText(o.recurringMinor, currency), installments: String(o.installments ?? 0),
    downOn: o.downPayment !== null, down: amountText(o.downPayment?.amountMinor, currency), downLabel: textDraft(o.downPayment?.label),
    collectionMethod: o.collectionMethod ?? 'REVIEW_REQUIRED', extraParticipant: amountText(o.additionalParticipantMinor, currency),
    capacity: String(o.capacity), availableThrough: o.availableThrough ?? '', mostPopular: o.mostPopular, createsMembership: o.createsMembership,
  };
}

/** The draft of a saved page. */
export function draftFrom(page: CheckoutPage): PageDraft {
  const c = page.content;
  return {
    pageId: page.pageId, version: page.version, slug: page.slug, groupKey: page.groupKey, currency: c.currency,
    title: textDraft(c.title), description: textDraft(c.description), blocks: c.blocks.map((b) => ({ position: b.position, text: textDraft(b.text) })),
    multiOn: c.multiParticipant.enabled, maxPerOrder: String(c.multiParticipant.maxPerOrder),
    customFields: c.customFields.map((f) => ({ key: f.key, label: textDraft(f.label), kind: f.kind, required: f.required, options: f.options.map(textDraft) })),
    addOns: c.addOns.map((a) => ({ key: a.key, label: textDraft(a.label), amount: minorToAmountText(a.amountMinor, a.currency), required: a.required })),
    options: c.options.map((o) => optionDraft(o, c.currency)),
    waiverOn: c.waiver !== null, waiver: textDraft(c.waiver?.text), receiptNote: textDraft(c.receiptNote), thankYou: textDraft(c.thankYou),
  };
}

/** A new, empty page in a group. */
export function newDraft(groupKey: string, currency: string, takenSlugs: readonly string[]): PageDraft {
  return {
    pageId: null, version: 0, slug: freeSlug('new-page', takenSlugs), groupKey, currency, title: EMPTY_TEXT, description: EMPTY_TEXT, blocks: [],
    multiOn: false, maxPerOrder: '1', customFields: [], addOns: [], options: [], waiverOn: false, waiver: EMPTY_TEXT, receiptNote: EMPTY_TEXT, thankYou: EMPTY_TEXT,
  };
}

/** "Duplicate page": the same content as a new page with its own free address. */
export function duplicateDraft(page: CheckoutPage, takenSlugs: readonly string[]): PageDraft {
  const d = draftFrom(page);
  return { ...d, pageId: null, version: 0, slug: freeSlug(`${page.slug}-copy`.slice(0, 55), takenSlugs), title: { ...d.title, en: `${d.title.en} (copy)`.slice(0, CHECKOUT_LIMITS.title) } };
}

/** A page address from a title: lowercase letters, digits and single hyphens. */
export function slugFrom(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
}
/** The first free address: base, base-2, base-3, … */
export function freeSlug(base: string, taken: readonly string[]): string {
  const clean = checkoutSlugOk(slugFrom(base)) ? slugFrom(base) : 'page';
  if (!taken.includes(clean)) return clean;
  for (let n = 2; ; n++) { const next = `${clean.slice(0, 55).replace(/-+$/g, '')}-${n}`; if (!taken.includes(next)) return next; }
}

/** A typed amount in minor units, or null when it does not fit the currency or the range (0 allowed only when said so). */
export function amountMinor(value: string, currency: string, allowZero = false): number | null {
  const minor = amountToMinor(value.trim(), currency, CHECKOUT_LIMITS.amountMinor);
  if (minor === null) return null;
  const n = Number(minor);
  return n >= (allowZero ? 0 : 1) ? n : null;
}
const whole = (value: string, minimum: number, maximum: number): number | null => /^(0|[1-9][0-9]{0,5})$/.test(value.trim()) && Number(value) >= minimum && Number(value) <= maximum ? Number(value) : null;

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
export const blankText = (text: TextDraft) => CHECKOUT_LANGUAGES.every((l) => cleanText(text[l], true) === '');

/** A new key: the first free one of prefix_1, prefix_2, … */
export function nextKey(prefix: 'addon' | 'question' | 'option', taken: readonly string[]): string {
  for (let n = 1; ; n++) if (!taken.includes(`${prefix}_${n}`)) return `${prefix}_${n}`;
}

/** The current CRM's size presets for a per-participant question. */
export const FIELD_PRESETS = {
  uniform: { label: 'Uniform size', options: ['000', '00', '0', '1', '2', '3', '4', '5', '6'] },
  belt: { label: 'Belt size', options: ['0', '1', '2', '3', '4', '5', '6', '7'] },
  shoe: { label: 'Shoe size', options: ['Youth 11', 'Youth 12', 'Youth 13', 'Adult 1', 'Adult 2', 'Adult 3', 'Adult 4', 'Adult 5', 'Adult 6', 'Adult 7'] },
  tshirt: { label: 'T-shirt size', options: ['Youth S', 'Youth M', 'Youth L', 'Adult S', 'Adult M', 'Adult L', 'Adult XL'] },
} as const;
export type FieldPreset = keyof typeof FIELD_PRESETS;

/** What staff must fix before this draft can be saved, in plain words. Empty when it can be sent. */
export function draftProblems(draft: PageDraft, status: CheckoutPageStatus, plans: readonly CheckoutPlanChoice[], takenSlugs: readonly string[], groupKeys: readonly string[]): string[] {
  const problems: string[] = [];
  const text = (t: TextDraft, max: number, multiline: boolean, what: string) => {
    for (const language of CHECKOUT_LANGUAGES) {
      const v = cleanText(t[language], multiline);
      if (language === 'en' && v === '') { problems.push(`${what} needs English text.`); continue; }
      if (v !== '' && !checkoutTextOk(v, max, multiline)) problems.push(`${what} (${language === 'en' ? 'English' : language === 'ko' ? 'Korean' : 'Spanish'}) must be at most ${max} characters, without < or >.`);
    }
  };
  const money = (value: string, what: string, allowZero = false) => {
    if (amountMinor(value, draft.currency, allowZero) === null) problems.push(`${what} needs a plain amount in ${draft.currency}, such as ${draft.currency === 'USD' ? '25 or 25.00' : 'the price without symbols'}.`);
  };
  if (draft.pageId === null) {
    if (!checkoutSlugOk(draft.slug)) problems.push('The page address can use lowercase letters, numbers and single hyphens (2 to 60 characters).');
    else if (takenSlugs.includes(draft.slug)) problems.push('Another page already uses this address. Choose a different one.');
  }
  if (!groupKeys.includes(draft.groupKey)) problems.push('Choose a page group.');
  text(draft.title, CHECKOUT_LIMITS.title, false, 'The page title');
  if (!blankText(draft.description)) text(draft.description, CHECKOUT_LIMITS.description, true, 'The description');
  if (draft.blocks.length > CHECKOUT_LIMITS.blocks) problems.push(`Use at most ${CHECKOUT_LIMITS.blocks} text sections.`);
  draft.blocks.forEach((b, i) => text(b.text, CHECKOUT_LIMITS.block, true, `Text section ${i + 1}`));
  if (draft.multiOn && whole(draft.maxPerOrder, 2, CHECKOUT_LIMITS.participants) === null) problems.push(`Allow 2 to ${CHECKOUT_LIMITS.participants} participants per order.`);
  if (draft.customFields.length > CHECKOUT_LIMITS.fields) problems.push(`Use at most ${CHECKOUT_LIMITS.fields} questions.`);
  draft.customFields.forEach((f, i) => {
    text(f.label, CHECKOUT_LIMITS.question, false, `Question ${i + 1}`);
    if (f.kind === 'CHOICE') {
      if (f.options.length < 2 || f.options.length > CHECKOUT_LIMITS.choiceOptions) problems.push(`Question ${i + 1} needs 2 to ${CHECKOUT_LIMITS.choiceOptions} choices.`);
      f.options.forEach((o, j) => text(o, CHECKOUT_LIMITS.label, false, `Question ${i + 1} choice ${j + 1}`));
    }
  });
  if (draft.addOns.length > CHECKOUT_LIMITS.addOns) problems.push(`Use at most ${CHECKOUT_LIMITS.addOns} add-ons.`);
  draft.addOns.forEach((a, i) => { text(a.label, CHECKOUT_LIMITS.label, false, `Add-on ${i + 1} name`); money(a.amount, `Add-on ${i + 1}`); });
  if (draft.options.length > CHECKOUT_LIMITS.options) problems.push(`Use at most ${CHECKOUT_LIMITS.options} pricing options.`);
  if (status === 'PUBLISHED' && draft.options.length === 0) problems.push('Add at least one pricing option before publishing.');
  if (draft.options.filter((o) => o.mostPopular).length > 1) problems.push('Mark only one option as "Most popular".');
  draft.options.forEach((o, i) => {
    const what = `Option ${i + 1}`;
    text(o.label, CHECKOUT_LIMITS.label, false, `${what} name`);
    if (!blankText(o.description)) text(o.description, CHECKOUT_LIMITS.note, true, `${what} description`);
    if (o.billing === 'ONE_TIME') money(o.price, `${what} price`, true);
    else {
      money(o.recurring, `${what} monthly amount`);
      if (whole(o.installments, 0, CHECKOUT_LIMITS.installments) === null) problems.push(`${what}: the number of monthly payments is 0 (ongoing) to ${CHECKOUT_LIMITS.installments}.`);
      if (o.downOn) { money(o.down, `${what} down payment`); text(o.downLabel, CHECKOUT_LIMITS.label, false, `${what} down payment label`); }
    }
    if (o.extraParticipant.trim() !== '') money(o.extraParticipant, `${what} extra participant fee`, true);
    if (whole(o.capacity, 0, CHECKOUT_LIMITS.capacity) === null) problems.push(`${what}: enrollment capacity is a whole number (0 means unlimited).`);
    if (o.availableThrough !== '' && !checkoutDateOk(o.availableThrough)) problems.push(`${what}: "available through" must be a real date.`);
    if (o.createsMembership && o.planId === null) problems.push(`${what}: choose the membership plan it creates, or turn off "Creates membership".`);
    if (o.planId !== null && status !== 'ARCHIVED') {
      const plan = plans.find((p) => p.planId === o.planId);
      if (!plan || !plan.available) problems.push(`${what}: ${plan ? plan.displayName : 'its plan'} is no longer available. Choose another plan.`);
    }
  });
  if (draft.waiverOn) text(draft.waiver, CHECKOUT_LIMITS.waiver, true, 'The waiver');
  if (!blankText(draft.receiptNote)) text(draft.receiptNote, CHECKOUT_LIMITS.note, true, 'The receipt note');
  if (!blankText(draft.thankYou)) text(draft.thankYou, CHECKOUT_LIMITS.note, true, 'The thank-you message');
  return problems;
}

/** The content to send. It throws when the draft is not acceptable; the contract validator is the final word. */
export function contentFrom(draft: PageDraft): CheckoutContent {
  const cur = draft.currency;
  return validateCheckoutContent({
    currency: cur, title: translated(draft.title, false), description: blankText(draft.description) ? null : translated(draft.description, true),
    blocks: draft.blocks.map((b) => ({ position: b.position, text: translated(b.text, true) })),
    multiParticipant: { enabled: draft.multiOn, maxPerOrder: draft.multiOn ? whole(draft.maxPerOrder, 2, CHECKOUT_LIMITS.participants) : 1 },
    customFields: draft.customFields.map((f) => ({ key: f.key, label: translated(f.label, false), kind: f.kind, required: f.required,
      options: f.kind === 'CHOICE' ? f.options.map((o) => translated(o, false)) : [] })),
    addOns: draft.addOns.map((a) => ({ key: a.key, label: translated(a.label, false), amountMinor: amountMinor(a.amount, cur), currency: cur, required: a.required })),
    options: draft.options.map((o) => {
      const monthly = o.billing === 'MONTHLY';
      return {
        key: o.key, label: translated(o.label, false), description: blankText(o.description) ? null : translated(o.description, true), planId: o.planId, billing: o.billing,
        priceMinor: monthly ? null : amountMinor(o.price, cur, true), recurringMinor: monthly ? amountMinor(o.recurring, cur) : null,
        installments: monthly ? whole(o.installments, 0, CHECKOUT_LIMITS.installments) : null,
        downPayment: monthly && o.downOn ? { amountMinor: amountMinor(o.down, cur), label: translated(o.downLabel, false) } : null,
        collectionMethod: monthly ? o.collectionMethod : null,
        additionalParticipantMinor: o.extraParticipant.trim() === '' ? null : amountMinor(o.extraParticipant, cur, true),
        capacity: whole(o.capacity, 0, CHECKOUT_LIMITS.capacity), availableThrough: o.availableThrough === '' ? null : o.availableThrough,
        mostPopular: o.mostPopular, createsMembership: o.createsMembership && o.planId !== null,
      };
    }),
    waiver: draft.waiverOn ? { text: translated(draft.waiver, true) } : null,
    receiptNote: blankText(draft.receiptNote) ? null : translated(draft.receiptNote, true),
    thankYou: blankText(draft.thankYou) ? null : translated(draft.thankYou, true),
  });
}

/** The save request for a draft; it throws when the draft cannot be sent. */
export function saveInputFrom(draft: PageDraft, status: CheckoutPageStatus): SaveCheckoutPageInput {
  return { pageId: draft.pageId, expectedVersion: draft.version, slug: draft.slug, groupKey: draft.groupKey, status, content: contentFrom(draft) };
}

/** "From $450 + $225/mo" or "From $945" for a page card, like the current CRM; null when the page has no options. */
export function fromPrice(content: CheckoutContent): string | null {
  if (content.options.length === 0) return null;
  const cur = content.currency;
  const label = (o: CheckoutOption) => o.billing === 'ONE_TIME' ? formatMinor(o.priceMinor ?? 0, cur)
    : o.downPayment ? `${formatMinor(o.downPayment.amountMinor, cur)} + ${formatMinor(o.recurringMinor ?? 0, cur)}/mo` : `${formatMinor(o.recurringMinor ?? 0, cur)}/mo`;
  const cheapest = [...content.options].sort((a, b) => dueToday(a) - dueToday(b))[0] as CheckoutOption;
  return content.options.length === 1 ? label(cheapest) : `From ${label(cheapest)}`;
}
const dueToday = (o: CheckoutOption) => o.billing === 'ONE_TIME' ? o.priceMinor ?? 0 : o.downPayment?.amountMinor ?? o.recurringMinor ?? 0;

/** The plain summary under a monthly option, as in the current CRM: what is paid today and then each month. */
export function optionSummary(o: OptionDraft, currency: string): string | null {
  const fmt = (v: string, zero = false) => { const m = amountMinor(v, currency, zero); return m === null ? null : formatMinor(m, currency); };
  if (o.billing === 'ONE_TIME') { const p = fmt(o.price, true); return p ? `Customer pays ${p} today.` : null; }
  const monthly = fmt(o.recurring), n = whole(o.installments, 0, CHECKOUT_LIMITS.installments);
  if (!monthly || n === null) return null;
  const today = o.downOn ? fmt(o.down) : monthly;
  if (!today) return null;
  const label = o.downOn && cleanText(o.downLabel.en, false) ? ` (${cleanText(o.downLabel.en, false)})` : '';
  const then = o.downOn ? `then ${monthly}/mo starting 1 month after purchase` : `then ${monthly}/mo`;
  return `Customer pays ${today} today${label}, ${then}${n === 0 ? ', ongoing' : `, ${n} monthly payments in all`}.`;
}

/** Every edit the editor offers, as one pure step on the draft. */
export type PageEdit =
  | { type: 'meta'; patch: Partial<Pick<PageDraft, 'slug' | 'groupKey' | 'currency' | 'multiOn' | 'maxPerOrder' | 'waiverOn'>> }
  | { type: 'text'; target: 'title' | 'description' | 'waiver' | 'receiptNote' | 'thankYou'; text: TextDraft }
  | { type: 'addBlock'; position: CheckoutBlockPosition } | { type: 'block'; index: number; patch: Partial<BlockDraft> } | { type: 'removeBlock'; index: number }
  | { type: 'addAddOn' } | { type: 'addOn'; index: number; patch: Partial<Omit<AddOnDraft, 'key'>> } | { type: 'removeAddOn'; index: number }
  | { type: 'addField'; preset?: FieldPreset } | { type: 'field'; index: number; patch: Partial<Omit<FieldDraft, 'key' | 'options'>> } | { type: 'removeField'; index: number }
  | { type: 'addChoice'; index: number } | { type: 'choice'; index: number; choice: number; text: TextDraft } | { type: 'removeChoice'; index: number; choice: number }
  | { type: 'addOption'; billing: CheckoutBilling } | { type: 'option'; index: number; patch: Partial<Omit<OptionDraft, 'key'>> }
  | { type: 'removeOption'; index: number } | { type: 'moveOption'; index: number; by: -1 | 1 } | { type: 'duplicateOption'; index: number };

const at = <T>(list: readonly T[], index: number, next: (item: T) => T): T[] => list.map((item, i) => i === index ? next(item) : item);
function blankOption(key: string, billing: CheckoutBilling): OptionDraft {
  return { key, label: EMPTY_TEXT, description: EMPTY_TEXT, planId: null, billing, price: '', recurring: '', installments: '0', downOn: false, down: '', downLabel: EMPTY_TEXT,
    collectionMethod: 'REVIEW_REQUIRED', extraParticipant: '', capacity: '0', availableThrough: '', mostPopular: false, createsMembership: false };
}
export function editPage(draft: PageDraft, edit: PageEdit): PageDraft {
  switch (edit.type) {
    case 'meta': {
      const next = { ...draft, ...edit.patch };
      // A page address is fixed once the page exists; single participant means one per order.
      return { ...next, slug: draft.pageId === null ? next.slug : draft.slug, maxPerOrder: next.multiOn ? (draft.multiOn ? next.maxPerOrder : '4') : '1' };
    }
    case 'text': {
      const next = { ...draft, [edit.target]: edit.text };
      // A new page's address follows its English title until staff type an address themselves.
      if (edit.target === 'title' && draft.pageId === null && (draft.slug === slugFrom(draft.title.en) || /^new-page(-\d+)?$/.test(draft.slug))) {
        const s = slugFrom(edit.text.en); return checkoutSlugOk(s) ? { ...next, slug: s } : next;
      }
      return next;
    }
    case 'addBlock': return { ...draft, blocks: [...draft.blocks, { position: edit.position, text: EMPTY_TEXT }] };
    case 'block': return { ...draft, blocks: at(draft.blocks, edit.index, (b) => ({ ...b, ...edit.patch })) };
    case 'removeBlock': return { ...draft, blocks: draft.blocks.filter((_, i) => i !== edit.index) };
    case 'addAddOn': return { ...draft, addOns: [...draft.addOns, { key: nextKey('addon', draft.addOns.map((a) => a.key)), label: EMPTY_TEXT, amount: '', required: false }] };
    case 'addOn': return { ...draft, addOns: at(draft.addOns, edit.index, (a) => ({ ...a, ...edit.patch })) };
    case 'removeAddOn': return { ...draft, addOns: draft.addOns.filter((_, i) => i !== edit.index) };
    case 'addField': {
      const key = nextKey('question', draft.customFields.map((f) => f.key));
      const preset = edit.preset ? FIELD_PRESETS[edit.preset] : null;
      return { ...draft, customFields: [...draft.customFields, preset
        ? { key, label: english(preset.label), kind: 'CHOICE', required: true, options: preset.options.map(english) }
        : { key, label: EMPTY_TEXT, kind: 'TEXT', required: false, options: [] }] };
    }
    case 'field': return { ...draft, customFields: at(draft.customFields, edit.index, (f) => {
      const next = { ...f, ...edit.patch };
      // A choice question starts with two empty choices; other kinds have none.
      return { ...next, options: next.kind === 'CHOICE' ? (f.kind === 'CHOICE' ? f.options : [EMPTY_TEXT, EMPTY_TEXT]) : [] };
    }) };
    case 'removeField': return { ...draft, customFields: draft.customFields.filter((_, i) => i !== edit.index) };
    case 'addChoice': return { ...draft, customFields: at(draft.customFields, edit.index, (f) => ({ ...f, options: [...f.options, EMPTY_TEXT] })) };
    case 'choice': return { ...draft, customFields: at(draft.customFields, edit.index, (f) => ({ ...f, options: at(f.options, edit.choice, () => edit.text) })) };
    case 'removeChoice': return { ...draft, customFields: at(draft.customFields, edit.index, (f) => ({ ...f, options: f.options.filter((_, j) => j !== edit.choice) })) };
    case 'addOption': return { ...draft, options: [...draft.options, blankOption(nextKey('option', draft.options.map((o) => o.key)), edit.billing)] };
    case 'option': return { ...draft, options: draft.options.map((o, i) => {
      if (i !== edit.index) return edit.patch.mostPopular ? { ...o, mostPopular: false } : o;
      const next = { ...o, ...edit.patch };
      return { ...next, createsMembership: next.planId === null ? false : next.createsMembership };
    }) };
    case 'removeOption': return { ...draft, options: draft.options.filter((_, i) => i !== edit.index) };
    case 'moveOption': {
      const to = edit.index + edit.by;
      if (to < 0 || to >= draft.options.length) return draft;
      const options = [...draft.options]; [options[edit.index], options[to]] = [options[to] as OptionDraft, options[edit.index] as OptionDraft];
      return { ...draft, options };
    }
    case 'duplicateOption': {
      const source = draft.options[edit.index];
      if (!source || draft.options.length >= CHECKOUT_LIMITS.options) return draft;
      const copy = { ...source, key: nextKey('option', draft.options.map((o) => o.key)), mostPopular: false, label: { ...source.label, en: `${source.label.en} (copy)`.slice(0, CHECKOUT_LIMITS.label) } };
      return { ...draft, options: [...draft.options.slice(0, edit.index + 1), copy, ...draft.options.slice(edit.index + 1)] };
    }
  }
}
