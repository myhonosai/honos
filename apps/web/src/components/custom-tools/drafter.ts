import { CUSTOM_TOOL_KEY, CUSTOM_TOOL_LIMITS, type CustomToolDefinition, type CustomToolEntity, type CustomToolField, type CustomToolFieldType, type CustomToolIcon } from '@hon/contracts';
import { defaultViews, makeKey, reconcile } from './model';
import { templateCopy, type ToolTemplateKey } from './templates';

/**
 * Turns an owner's plain-language request into a closed tool design (0415 definition). The drafter only ever returns a
 * definition; the browser and the server both check it before anything is saved, so a drafter can never add code, SQL
 * or permissions. Access is never set by a drafter: the owner answers "who can use it" separately.
 *
 * `standInDrafter` runs in the browser with no AI and no cost: it matches words to the closest template and understands
 * a few simple change requests ("add belt color", "remove notes", "rename date to awarded on", "call it ..."). The real
 * AI drafter (CM-3) replaces it behind the same interface once the owner approves AI use.
 */
export type DraftOutcome =
  | { kind: 'OK'; toolKey: string; definition: CustomToolDefinition; changed: string[] }
  | { kind: 'UNSURE' };
export type ToolDrafter = Readonly<{
  real: boolean;
  create(prompt: string, taken: readonly string[]): Promise<DraftOutcome>;
  change(prompt: string, current: CustomToolDefinition): Promise<DraftOutcome>;
}>;

const MAX_PROMPT = 1000;
export const cleanPrompt = (s: string) => s.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT);

const MATCHES: ReadonlyArray<[ToolTemplateKey, RegExp]> = [
  ['leadership_points', /\b(points?|leadership|merit|reward|award|stars?|stripe)\b|포인트|리더십|puntos|liderazgo/i],
  ['demo_team', /\b(demo|demonstration|exhibition|performance team|show team)\b|시범|exhibici[oó]n/i],
  ['tournament', /\b(tournament|competition|sparring|bracket|division|scor(e|es|ing)|judges?)\b|대회|시합|torneo|competencia/i],
];

/** Common words that describe the request rather than name the tool. */
const FILLER = /^(please |i (want|need|would like) |can you |could you |help me |make |create |build |set up |add |a |an |the |new |simple |tool |app |page |section |to |for |that |which |lets? (us|me) |keep track of |keeping track of |track(ing)? |record(ing)? |log(ging)? |manage |managing )+/i;

const titleCase = (s: string) => s.replace(/\b[a-z]/g, c => c.toUpperCase());

function guessType(name: string): Pick<CustomToolField, 'type'> & Partial<CustomToolField> {
  const n = name.toLowerCase();
  if (/\b(date|day|birthday|when|deadline)\b/.test(n)) return { type: 'DATE' };
  if (/\b(points?|score|count|number|amount|minutes|hours|age|laps|reps|rank|place)\b/.test(n)) return { type: 'INTEGER' };
  if (/\b(paid|done|finished|passed|active|attended|yes ?\/ ?no|approved|signed)\b/.test(n)) return { type: 'BOOLEAN' };
  if (/\b(student|kid|child|member|athlete)\b/.test(n)) return { type: 'STUDENT_REF' };
  if (/\b(coach|instructor|teacher|staff|judge)\b/.test(n)) return { type: 'STAFF_REF' };
  if (/\b(notes?|comments?|details|description)\b/.test(n)) return { type: 'LONG_TEXT', maxLength: 2000 };
  return { type: 'TEXT', maxLength: 200 };
}

const ICON_FOR: ReadonlyArray<[CustomToolIcon, RegExp]> = [
  ['trophy', /\b(win|award|trophy|champion|medal)/i], ['calendar', /\b(event|schedule|calendar|class|practice)/i],
  ['book', /\b(book|lesson|curriculum|homework|reading)/i], ['box', /\b(inventory|equipment|gear|stock|uniform)/i],
  ['heart', /\b(health|injur|care|wellness)/i], ['flag', /\b(goal|mission|challenge)/i], ['chart', /\b(progress|test|measure)/i],
];

function splitList(s: string): string[] {
  return s.split(/,|\band\b|\bplus\b|;|&/i).map(x => x.replace(/^(a|an|the|their|his|her|its)\s+/i, '').replace(/\s+(field|column|box)s?$/i, '').trim()).filter(x => x.length >= 2 && x.length <= 60);
}

function addField(entity: CustomToolEntity, label: string): CustomToolField | null {
  if (entity.fields.length >= CUSTOM_TOOL_LIMITS.fieldsPerEntity) return null;
  const nice = titleCase(label.toLowerCase()).slice(0, 80);
  if (entity.fields.some(f => f.label.en.toLowerCase() === nice.toLowerCase())) return null;
  const field: CustomToolField = { key: makeKey(label, entity.fields.map(f => f.key), 'field'), label: { en: nice }, ...guessType(label) };
  entity.fields.push(field);
  return field;
}

/** A one-list tool shaped from the words of the request. */
function genericTool(prompt: string, taken: readonly string[]): { toolKey: string; definition: CustomToolDefinition } {
  const [head = '', tail = ''] = prompt.split(/\b(?:with|including|that has|showing|columns?|fields?)\b:?/i, 2);
  const words = head.replace(FILLER, '').replace(/[^\p{L}\p{N}' -]/gu, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 5).join(' ');
  const name = titleCase(words || 'My tool').slice(0, 60);
  const entity: CustomToolEntity = { key: 'entry', label: { en: 'Entry' }, fields: [] };
  if (/\b(student|kid|child|member|athlete)s?\b|학생|alumno/i.test(prompt)) entity.fields.push({ key: 'student', label: { en: 'Student', ko: '학생', es: 'Alumno' }, type: 'STUDENT_REF', required: true });
  for (const item of splitList(tail)) addField(entity, item);
  if (!entity.fields.some(f => f.type !== 'STUDENT_REF')) entity.fields.push({ key: 'title', label: { en: 'Title', ko: '제목', es: 'Título' }, type: 'TEXT', required: true, maxLength: 120 });
  if (!entity.fields.some(f => f.type === 'DATE')) entity.fields.push({ key: 'date', label: { en: 'Date', ko: '날짜', es: 'Fecha' }, type: 'DATE', required: true });
  if (!entity.fields.some(f => f.type === 'LONG_TEXT')) entity.fields.push({ key: 'notes', label: { en: 'Notes', ko: '메모', es: 'Notas' }, type: 'LONG_TEXT', maxLength: 2000 });
  const views = defaultViews(entity, []);
  const icon = ICON_FOR.find(([, re]) => re.test(prompt))?.[0] ?? 'clipboard';
  return { toolKey: uniqueKey(name, taken), definition: { schemaVersion: 1, icon, name: { en: name }, description: { en: prompt.slice(0, 200) }, entities: [entity], views, navigation: [views[0]!.key], access: [] } };
}

function uniqueKey(name: string, taken: readonly string[]): string {
  const key = makeKey(name, taken, 'tool').slice(0, 40);
  return CUSTOM_TOOL_KEY.test(key) ? key : makeKey('my_tool', taken, 'tool');
}

const findField = (def: CustomToolDefinition, name: string) => {
  const n = name.trim().toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/\s+(field|column)$/, '');
  for (const e of def.entities) { const f = e.fields.find(x => x.label.en.toLowerCase() === n || x.key === n.replace(/\s+/g, '_')); if (f) return { e, f }; }
  return null;
};

/** Applies the simple change requests the stand-in understands; returns what changed, or [] when it did not understand. */
export function applyChange(prompt: string, current: CustomToolDefinition): { definition: CustomToolDefinition; changed: string[] } {
  const def = structuredClone(current) as CustomToolDefinition;
  const changed: string[] = [];
  for (const part of prompt.split(/[.;\n]|\bthen\b|\balso\b/i).map(s => s.trim()).filter(Boolean)) {
    let m: RegExpExecArray | null;
    if ((m = /^(?:please\s+)?(?:call it|name it|rename (?:the )?tool to)\s+(.+)$/i.exec(part))) {
      def.name = { en: titleCase(m[1]!.replace(/["']/g, '').trim()).slice(0, 80) }; changed.push(`name:${def.name.en}`);
    } else if ((m = /^(?:please\s+)?rename\s+(.+?)\s+to\s+(.+)$/i.exec(part))) {
      const hit = findField(def, m[1]!);
      if (hit) { hit.f.label = { en: titleCase(m[2]!.trim()).slice(0, 80) }; changed.push(`rename:${hit.f.key}`); }
    } else if ((m = /^(?:please\s+)?(?:remove|delete|drop|take out|get rid of)\s+(.+)$/i.exec(part))) {
      for (const item of splitList(m[1]!)) {
        const hit = findField(def, item);
        if (hit && hit.e.fields.length > 1) { hit.e.fields = hit.e.fields.filter(f => f !== hit.f); changed.push(`remove:${hit.f.key}`); }
      }
    } else if ((m = /^(?:please\s+)?make\s+(.+?)\s+(required|optional|not required)$/i.exec(part))) {
      const hit = findField(def, m[1]!);
      if (hit) { if (m[2]!.toLowerCase() === 'required') hit.f.required = true; else delete hit.f.required; changed.push(`required:${hit.f.key}`); }
    } else if ((m = /^(?:please\s+)?(?:add|include|track|also track|i want|we need)\s+(?:a |an |fields? (?:for )?|columns? (?:for )?)?(.+)$/i.exec(part))) {
      const entity = def.entities[0];
      if (!entity) continue;
      for (const item of splitList(m[1]!)) {
        const field = addField(entity, item);
        if (!field) continue;
        changed.push(`add:${field.key}`);
        for (const v of def.views) {
          if (v.entity !== entity.key) continue;
          if (v.type === 'FORM' && v.fields) v.fields.push(field.key);
          if (v.type === 'TABLE' && v.columns && v.columns.length < CUSTOM_TOOL_LIMITS.columns) v.columns.push(field.key);
        }
      }
    }
  }
  return { definition: changed.length ? reconcile(def) : current, changed };
}

export const standInDrafter: ToolDrafter = {
  real: false,
  async create(raw, taken) {
    const prompt = cleanPrompt(raw);
    if (prompt.length < 3) return { kind: 'UNSURE' };
    const match = MATCHES.find(([, re]) => re.test(prompt))?.[0];
    if (match) { const tp = templateCopy(match); return { kind: 'OK', toolKey: uniqueKey(tp.toolKey, taken), definition: tp.definition, changed: [] }; }
    return { kind: 'OK', ...genericTool(prompt, taken), changed: [] };
  },
  async change(raw, current) {
    const { definition, changed } = applyChange(cleanPrompt(raw), current);
    return changed.length ? { kind: 'OK', toolKey: '', definition, changed } : { kind: 'UNSURE' };
  },
};
