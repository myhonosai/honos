import {
  CUSTOM_TOOL_LIMITS, customToolDefinitionProblems,
  type CustomToolCard, type CustomToolDefinition, type CustomToolEntity, type CustomToolField, type CustomToolFieldType, type CustomToolLabel, type CustomToolView,
} from '@hon/contracts';

/**
 * Pure helpers for the Tool Maker and the tool screens. A design is a closed JSON definition (0415): nothing here runs
 * code, and the server validates every design and every value again. Keys are generated once and never renamed, so a
 * field keeps its stored values across versions (the database refuses a type change of a published field).
 */
export type Language = 'en' | 'ko' | 'es';
export const lang = (language: string): Language => language === 'ko' ? 'ko' : language === 'es' ? 'es' : 'en';
/** A label in the reader's language, falling back to English. */
export const labelText = (label: CustomToolLabel | null | undefined, language: string): string => label ? label[lang(language)] ?? label.en : '';

/** A safe key from an English label: lowercase letters, digits and underscores, starting with a letter, unique in `taken`. */
export function makeKey(text: string, taken: Iterable<string>, fallback = 'item'): string {
  const used = new Set(taken);
  let stem = text.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[0-9_]+/, '').slice(0, 32);
  if (stem.length < 2) stem = fallback;
  let key = stem, n = 2;
  while (used.has(key)) key = `${stem.slice(0, 36)}_${n++}`;
  return key;
}
/** A label with English always set; empty Korean or Spanish are dropped. Whitespace is trimmed so the server accepts it. */
export function cleanLabel(label: Partial<Record<Language, string>>, fallback = ''): CustomToolLabel {
  const out: CustomToolLabel = { en: (label.en ?? '').trim() || fallback };
  for (const k of ['ko', 'es'] as const) { const v = (label[k] ?? '').trim(); if (v) out[k] = v; }
  return out;
}

export const FIELD_TYPES_IN_ORDER: readonly CustomToolFieldType[] = ['TEXT', 'LONG_TEXT', 'INTEGER', 'NUMBER', 'BOOLEAN', 'DATE', 'CHOICE', 'MULTI_CHOICE', 'STUDENT_REF', 'STAFF_REF', 'RECORD_REF'];
export const isNumeric = (f: CustomToolField | undefined) => f?.type === 'INTEGER' || f?.type === 'NUMBER';
export const isGroupable = (f: CustomToolField | undefined) => !!f && ['STUDENT_REF', 'STAFF_REF', 'CHOICE', 'RECORD_REF'].includes(f.type);

/** A field of a new type, keeping its key and label. Options that no longer apply are dropped. */
export function retypeField(f: CustomToolField, type: CustomToolFieldType, entities: readonly CustomToolEntity[], self: string): CustomToolField {
  const next: CustomToolField = { key: f.key, label: f.label, type, ...(f.required ? { required: true } : {}) };
  if (type === 'CHOICE' || type === 'MULTI_CHOICE') next.choices = f.choices?.length ? f.choices : [{ key: 'option_1', label: { en: 'Option 1' } }];
  if (type === 'RECORD_REF') next.entity = f.entity ?? entities.find(e => e.key !== self)?.key ?? self;
  if ((type === 'INTEGER' || type === 'NUMBER') && (f.type === 'INTEGER' || f.type === 'NUMBER')) {
    if (f.min !== undefined) next.min = type === 'INTEGER' ? Math.round(f.min) : f.min;
    if (f.max !== undefined) next.max = type === 'INTEGER' ? Math.round(f.max) : f.max;
  }
  return next;
}

/** Views, navigation and cards that still fit after an edit: a removed field leaves every list, a removed entity takes its views. */
export function reconcile(def: CustomToolDefinition): CustomToolDefinition {
  const fields = new Map(def.entities.map(e => [e.key, new Map(e.fields.map(f => [f.key, f]))]));
  const entities = def.entities.map(e => ({ ...e, fields: e.fields.map(f => f.type === 'RECORD_REF' && !fields.has(f.entity ?? '') ? { ...f, entity: e.key } : f) }));
  const views: CustomToolView[] = [];
  for (const v of def.views) {
    const own = fields.get(v.entity);
    if (!own) continue;
    if (v.type === 'TABLE') {
      const columns = (v.columns ?? []).filter(k => own.has(k));
      const next: CustomToolView = { key: v.key, label: v.label, type: 'TABLE', entity: v.entity, columns: columns.length ? columns : [...own.keys()].slice(0, 1) };
      if (v.sort && own.has(v.sort.field)) next.sort = v.sort;
      views.push(next);
    } else if (v.type === 'FORM') {
      const list = (v.fields ?? []).filter(k => own.has(k));
      views.push({ key: v.key, label: v.label, type: 'FORM', entity: v.entity, fields: list.length ? list : [...own.keys()] });
    } else {
      const cards = (v.cards ?? []).filter(c => c.kind === 'COUNT'
        || (isNumeric(own.get(c.field ?? '')) && (c.kind !== 'LEADERBOARD' || isGroupable(own.get(c.groupBy ?? '')))));
      views.push({ key: v.key, label: v.label, type: 'DASHBOARD', entity: v.entity, cards: cards.length ? cards : [{ key: 'count', label: { en: 'Records' }, kind: 'COUNT' }] });
    }
  }
  const keys = new Set(views.map(v => v.key));
  const navigation = def.navigation.filter(k => keys.has(k));
  return { ...def, entities, views, navigation: navigation.length || !views[0] ? navigation : [views[0].key] };
}

/** Default screens for a new entity: a list of up to six columns and a form with every field. */
export function defaultViews(entity: CustomToolEntity, taken: Iterable<string>): CustomToolView[] {
  const used = new Set(taken);
  const list = makeKey(`${entity.key}_list`, used); used.add(list);
  const form = makeKey(`${entity.key}_form`, used);
  return [
    { key: list, label: entity.label, type: 'TABLE', entity: entity.key, columns: entity.fields.slice(0, 6).map(f => f.key) },
    { key: form, label: { en: `Add ${entity.label.en}`.slice(0, 80) }, type: 'FORM', entity: entity.key, fields: entity.fields.map(f => f.key) },
  ];
}

/** Problems the browser can see before saving; the server checks again (and also checks roles and field-type stability). */
export const designProblems = (def: CustomToolDefinition): string[] => customToolDefinitionProblems(def);
export const designBytes = (def: CustomToolDefinition): number => JSON.stringify(def).length;
export const designTooLarge = (def: CustomToolDefinition): boolean => designBytes(def) > CUSTOM_TOOL_LIMITS.definitionBytes;

/** The part of the design a problem path names, so the editor can show it next to that part. */
export function problemPlace(path: string, def: CustomToolDefinition, language: string): string {
  const e = /^entities\[(\d+)\](?:\.fields\[(\d+)\])?/.exec(path);
  if (e) {
    const entity = def.entities[Number(e[1])];
    const fieldLabel = e[2] !== undefined ? labelText(entity?.fields[Number(e[2])]?.label, language) : '';
    return [labelText(entity?.label, language), fieldLabel].filter(Boolean).join(' › ');
  }
  const v = /^views\[(\d+)\]/.exec(path);
  if (v) return labelText(def.views[Number(v[1])]?.label, language);
  return '';
}

/** One field's value as text for a list or a review. References show the name the server sent, never an id. */
export function valueText(f: CustomToolField, value: unknown, refs: Readonly<{ students: Record<string, string>; staff: Record<string, string>; records: Record<string, string> }>,
  language: string, yesNo: readonly [string, string]): string {
  if (value === undefined || value === null || value === '') return '';
  switch (f.type) {
    case 'BOOLEAN': return value === true ? yesNo[0] : value === false ? yesNo[1] : '';
    case 'CHOICE': return labelText(f.choices?.find(c => c.key === value)?.label, language) || String(value);
    case 'MULTI_CHOICE': return Array.isArray(value) ? value.map(k => labelText(f.choices?.find(c => c.key === k)?.label, language) || String(k)).join(', ') : '';
    case 'STUDENT_REF': return typeof value === 'string' ? refs.students[value] ?? '' : '';
    case 'STAFF_REF': return typeof value === 'string' ? refs.staff[value] ?? '' : '';
    case 'RECORD_REF': return typeof value === 'string' ? refs.records[value] ?? '' : '';
    case 'DATE': return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}T00:00:00Z`).toLocaleDateString(language, { dateStyle: 'medium', timeZone: 'UTC' }) : '';
    case 'INTEGER': case 'NUMBER': return typeof value === 'number' ? value.toLocaleString(language) : '';
    default: return typeof value === 'string' ? value : '';
  }
}

/** What a form holds while it is being filled: text for text-like inputs, booleans, key lists and reference ids. */
export type FormValue = string | boolean | string[];
export function formValueOf(f: CustomToolField, value: unknown): FormValue {
  if (f.type === 'BOOLEAN') return value === true;
  if (f.type === 'MULTI_CHOICE') return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' ? value : '';
}
export type ParsedForm = { data: Record<string, unknown>; problems: string[] };
/** Form values as record data. A field the browser can already see is wrong is named in `problems`; the server decides the rest. */
export function parseForm(fields: readonly CustomToolField[], values: Readonly<Record<string, FormValue>>): ParsedForm {
  const data: Record<string, unknown> = {}, problems: string[] = [];
  for (const f of fields) {
    const raw = values[f.key];
    let value: unknown = null;
    if (f.type === 'BOOLEAN') value = raw === true;
    else if (f.type === 'MULTI_CHOICE') value = Array.isArray(raw) && raw.length ? [...raw] : null;
    else {
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (text === '') value = null;
      else if (f.type === 'INTEGER' || f.type === 'NUMBER') {
        const n = Number(text.replace(/,/g, ''));
        if (!Number.isFinite(n) || (f.type === 'INTEGER' && !Number.isInteger(n)) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) { problems.push(f.key); continue; }
        value = n;
      } else value = text;
    }
    if (value === null && f.required && f.type !== 'BOOLEAN') { problems.push(f.key); continue; }
    data[f.key] = value;
  }
  return { data, problems };
}
export const cardText = (c: CustomToolCard, language: string) => labelText(c.label, language);
