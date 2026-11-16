// AI Customizer CM-1 (0415): a school's own custom tools. A tool is a closed, versioned definition (record types and
// fields, tables, forms, dashboards, its navigation and access per school role) that fixed HON code runs. Nothing in a
// definition is code, SQL, a policy or a permission. The database re-validates every definition and record; this file
// mirrors those rules so the screens and HON can explain a problem before anything is sent.

export const CUSTOM_TOOL_READ_COMMAND = 'custom_tool.read';
export const CUSTOM_TOOL_SAVE_COMMAND = 'custom_tool.draft.save';
export const CUSTOM_TOOL_CHANGE_COMMAND = 'custom_tool.change';
export const CUSTOM_TOOL_RECORD_COMMAND = 'custom_tool.record.write';

export const CUSTOM_TOOL_ICONS = ['star', 'trophy', 'users', 'calendar', 'clipboard', 'chart', 'box', 'flag', 'heart', 'shield', 'bolt', 'book'] as const;
export const CUSTOM_TOOL_FIELD_TYPES = ['TEXT', 'LONG_TEXT', 'INTEGER', 'NUMBER', 'BOOLEAN', 'DATE', 'CHOICE', 'MULTI_CHOICE', 'STUDENT_REF', 'STAFF_REF', 'RECORD_REF'] as const;
export const CUSTOM_TOOL_VIEW_TYPES = ['TABLE', 'FORM', 'DASHBOARD'] as const;
export const CUSTOM_TOOL_CARD_KINDS = ['COUNT', 'SUM', 'AVERAGE', 'LEADERBOARD'] as const;
export const CUSTOM_TOOL_CAPABILITIES = ['VIEW', 'CREATE', 'EDIT', 'ARCHIVE'] as const;
export const CUSTOM_TOOL_VERSION_STATUSES = ['DRAFT', 'PUBLISHED', 'SUPERSEDED', 'DISCARDED'] as const;
export const CUSTOM_TOOL_CHANGE_OPERATIONS = ['PUBLISH', 'DISCARD_DRAFT', 'RESTORE', 'ARCHIVE', 'UNARCHIVE'] as const;
export const CUSTOM_TOOL_RECORD_OPERATIONS = ['CREATE', 'UPDATE', 'ARCHIVE', 'RESTORE'] as const;
export const CUSTOM_TOOL_LIMITS = { toolsPerSchool: 25, definitionBytes: 32768, recordBytes: 8192, liveRecordsPerTool: 50000, previewRecordsPerDraft: 2000,
  entities: 10, fieldsPerEntity: 40, views: 20, navigation: 12, accessRules: 20, choices: 50, cards: 12, columns: 12, recordsPerPage: 200 } as const;

export type CustomToolIcon = typeof CUSTOM_TOOL_ICONS[number];
export type CustomToolFieldType = typeof CUSTOM_TOOL_FIELD_TYPES[number];
export type CustomToolCapability = typeof CUSTOM_TOOL_CAPABILITIES[number];
export type CustomToolVersionStatus = typeof CUSTOM_TOOL_VERSION_STATUSES[number];
export type CustomToolChangeOperation = typeof CUSTOM_TOOL_CHANGE_OPERATIONS[number];
export type CustomToolRecordOperation = typeof CUSTOM_TOOL_RECORD_OPERATIONS[number];
/** English is required; Korean and Spanish are optional. */
export type CustomToolLabel = { en: string; ko?: string; es?: string };
export type CustomToolField = {
  key: string; label: CustomToolLabel; type: CustomToolFieldType; required?: boolean;
  maxLength?: number; min?: number; max?: number; choices?: { key: string; label: CustomToolLabel }[]; entity?: string;
};
export type CustomToolEntity = { key: string; label: CustomToolLabel; fields: CustomToolField[] };
export type CustomToolCard = { key: string; label: CustomToolLabel; kind: typeof CUSTOM_TOOL_CARD_KINDS[number]; field?: string; groupBy?: string };
export type CustomToolView = {
  key: string; label: CustomToolLabel; type: typeof CUSTOM_TOOL_VIEW_TYPES[number]; entity: string;
  columns?: string[]; sort?: { field: string; direction: 'ASC' | 'DESC' }; fields?: string[]; cards?: CustomToolCard[];
};
export type CustomToolAccessRule = { roleId: string; capabilities: CustomToolCapability[] };
export type CustomToolDefinition = {
  schemaVersion: 1; name: CustomToolLabel; description?: CustomToolLabel; icon: CustomToolIcon;
  entities: CustomToolEntity[]; views: CustomToolView[]; navigation: string[]; access: CustomToolAccessRule[];
};

const KEY = /^[a-z][a-z0-9_]{0,39}$/;
export const CUSTOM_TOOL_KEY = /^[a-z][a-z0-9_]{1,39}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// eslint-disable-next-line no-control-regex
const LONG_CONTROL = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
function shape(v: unknown, required: readonly string[], optional: readonly string[] = []): v is Obj {
  if (!isObj(v)) return false;
  const keys = Object.keys(v);
  return keys.every(k => required.includes(k) || optional.includes(k)) && required.every(k => k in v);
}
const keyOk = (v: unknown): v is string => typeof v === 'string' && KEY.test(v);
export function customToolLabelOk(v: unknown, max = 80): v is CustomToolLabel {
  return isObj(v) && 'en' in v && Object.entries(v).every(([k, s]) => ['en', 'ko', 'es'].includes(k) && typeof s === 'string'
    && s.length >= 1 && s.length <= max && s === s.trim() && !CONTROL.test(s));
}
const numberOk = (v: unknown, integer: boolean): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e12 && (!integer || Number.isInteger(v));
const uniqueStrings = (v: unknown[]): boolean => new Set(v.map(x => JSON.stringify(x))).size === v.length;

/**
 * Every problem in a definition, as paths like `entities[0].fields[2]`. Empty means the shape is valid; the database
 * additionally checks that named roles are usable at the school and that no field changes type between versions.
 */
export function customToolDefinitionProblems(def: unknown): string[] {
  const problems: string[] = [];
  const bad = (path: string) => { problems.push(path); };
  if (!shape(def, ['schemaVersion', 'name', 'icon', 'entities', 'views', 'navigation', 'access'], ['description']) || def.schemaVersion !== 1
    || JSON.stringify(def).length > CUSTOM_TOOL_LIMITS.definitionBytes) return ['definition'];
  if (!customToolLabelOk(def.name, 80)) bad('name');
  if ('description' in def && !customToolLabelOk(def.description, 400)) bad('description');
  if (!(CUSTOM_TOOL_ICONS as readonly unknown[]).includes(def.icon)) bad('icon');
  const entities = Array.isArray(def.entities) ? def.entities : [];
  if (!Array.isArray(def.entities) || entities.length < 1 || entities.length > CUSTOM_TOOL_LIMITS.entities) bad('entities');
  const fieldsOf = new Map<string, Map<string, Obj>>();
  entities.forEach((e, i) => {
    const path = `entities[${i}]`;
    if (!shape(e, ['key', 'label', 'fields']) || !keyOk(e.key) || fieldsOf.has(e.key) || !customToolLabelOk(e.label)
      || !Array.isArray(e.fields) || e.fields.length < 1 || e.fields.length > CUSTOM_TOOL_LIMITS.fieldsPerEntity) { bad(path); return; }
    fieldsOf.set(e.key, new Map());
  });
  entities.forEach((e, i) => {
    if (!isObj(e) || !keyOk(e.key) || !Array.isArray(e.fields)) return;
    const fields = fieldsOf.get(e.key); if (!fields) return;
    e.fields.forEach((f: unknown, j: number) => {
      const path = `entities[${i}].fields[${j}]`;
      if (!isObj(f) || !keyOk(f.key) || fields.has(f.key) || !customToolLabelOk(f.label) || !(CUSTOM_TOOL_FIELD_TYPES as readonly unknown[]).includes(f.type)
        || ('required' in f && typeof f.required !== 'boolean')) { bad(path); return; }
      const t = f.type as CustomToolFieldType;
      let ok: boolean;
      if (t === 'TEXT' || t === 'LONG_TEXT') ok = shape(f, ['key', 'label', 'type'], ['required', 'maxLength'])
        && (!('maxLength' in f) || (numberOk(f.maxLength, true) && f.maxLength >= 1 && f.maxLength <= (t === 'TEXT' ? 500 : 4000)));
      else if (t === 'INTEGER' || t === 'NUMBER') ok = shape(f, ['key', 'label', 'type'], ['required', 'min', 'max'])
        && (!('min' in f) || numberOk(f.min, t === 'INTEGER')) && (!('max' in f) || numberOk(f.max, t === 'INTEGER'))
        && !('min' in f && 'max' in f && (f.min as number) > (f.max as number));
      else if (t === 'CHOICE' || t === 'MULTI_CHOICE') {
        ok = shape(f, ['key', 'label', 'type', 'choices'], ['required']) && Array.isArray(f.choices) && f.choices.length >= 1 && f.choices.length <= CUSTOM_TOOL_LIMITS.choices;
        if (ok) { const seen = new Set<string>(); for (const c of f.choices as unknown[]) {
          if (!shape(c, ['key', 'label']) || !keyOk(c.key) || seen.has(c.key) || !customToolLabelOk(c.label)) { ok = false; bad(path + '.choices'); break; }
          seen.add(c.key); } if (!ok) return; }
      } else if (t === 'RECORD_REF') {
        ok = shape(f, ['key', 'label', 'type', 'entity'], ['required']) && keyOk(f.entity) && fieldsOf.has(f.entity);
        if (!ok) { bad(path + '.entity'); return; }
      } else ok = shape(f, ['key', 'label', 'type'], ['required']);
      if (!ok) { bad(path); return; }
      fields.set(f.key, f);
    });
  });
  const field = (entity: unknown, key: unknown) => (typeof entity === 'string' && typeof key === 'string') ? fieldsOf.get(entity)?.get(key) : undefined;
  const views = Array.isArray(def.views) ? def.views : [];
  if (!Array.isArray(def.views) || views.length < 1 || views.length > CUSTOM_TOOL_LIMITS.views) bad('views');
  const viewKeys = new Set<string>();
  views.forEach((v, i) => {
    const path = `views[${i}]`;
    if (!isObj(v) || !keyOk(v.key) || viewKeys.has(v.key) || !customToolLabelOk(v.label) || !keyOk(v.entity) || !fieldsOf.has(v.entity)) { bad(path); return; }
    const fieldList = (list: unknown, max: number) => Array.isArray(list) && list.length >= 1 && list.length <= max && uniqueStrings(list) && list.every(k => field(v.entity, k));
    let ok = false;
    if (v.type === 'TABLE') ok = shape(v, ['key', 'label', 'type', 'entity', 'columns'], ['sort']) && fieldList(v.columns, CUSTOM_TOOL_LIMITS.columns)
      && (!('sort' in v) || (shape(v.sort, ['field', 'direction']) && !!field(v.entity, v.sort.field) && (v.sort.direction === 'ASC' || v.sort.direction === 'DESC')));
    else if (v.type === 'FORM') ok = shape(v, ['key', 'label', 'type', 'entity', 'fields']) && fieldList(v.fields, CUSTOM_TOOL_LIMITS.fieldsPerEntity);
    else if (v.type === 'DASHBOARD') {
      ok = shape(v, ['key', 'label', 'type', 'entity', 'cards']) && Array.isArray(v.cards) && v.cards.length >= 1 && v.cards.length <= CUSTOM_TOOL_LIMITS.cards;
      if (ok) { const seen = new Set<string>(); for (const c of v.cards as unknown[]) {
        const numeric = isObj(c) && ['INTEGER', 'NUMBER'].includes(String(field(v.entity, c.field)?.type));
        const cardOk = isObj(c) && keyOk(c.key) && !seen.has(c.key) && customToolLabelOk(c.label) && (
          c.kind === 'COUNT' ? shape(c, ['key', 'label', 'kind'])
          : c.kind === 'SUM' || c.kind === 'AVERAGE' ? shape(c, ['key', 'label', 'kind', 'field']) && numeric
          : c.kind === 'LEADERBOARD' ? shape(c, ['key', 'label', 'kind', 'field', 'groupBy']) && numeric
            && ['STUDENT_REF', 'STAFF_REF', 'CHOICE', 'RECORD_REF'].includes(String(field(v.entity, c.groupBy)?.type))
          : false);
        if (!cardOk) { bad(path + '.cards'); return; }
        seen.add(c.key as string); } }
    } else { bad(path + '.type'); return; }
    if (!ok) { bad(path); return; }
    viewKeys.add(v.key);
  });
  if (!Array.isArray(def.navigation) || def.navigation.length < 1 || def.navigation.length > CUSTOM_TOOL_LIMITS.navigation || !uniqueStrings(def.navigation)
    || !def.navigation.every(k => typeof k === 'string' && viewKeys.has(k))) bad('navigation');
  if (!Array.isArray(def.access) || def.access.length > CUSTOM_TOOL_LIMITS.accessRules) bad('access');
  else { const roles = new Set<string>(); for (const a of def.access as unknown[]) {
    if (!shape(a, ['roleId', 'capabilities']) || typeof a.roleId !== 'string' || !UUID.test(a.roleId) || roles.has(a.roleId) || !Array.isArray(a.capabilities)
      || a.capabilities.length < 1 || a.capabilities.length > 4 || !uniqueStrings(a.capabilities) || !a.capabilities.includes('VIEW')
      || !a.capabilities.every(c => (CUSTOM_TOOL_CAPABILITIES as readonly unknown[]).includes(c))) { bad('access'); break; }
    roles.add(a.roleId); } }
  return problems;
}
function fail(what: string): never { throw new Error(`Unverified custom tool ${what}.`); }
export function validateCustomToolDefinition(def: unknown): CustomToolDefinition {
  if (customToolDefinitionProblems(def).length) fail('definition');
  return def as CustomToolDefinition;
}

// ----- inputs ----------------------------------------------------------------------------------------------------
export type CustomToolDraftInput = { toolId: string | null; toolKey: string | null; expectedRevision: number; definition: CustomToolDefinition };
export type CustomToolChangeInput = { operation: CustomToolChangeOperation; expectedRevision: number; version: number | null };
export type CustomToolRecordInput = { operation: CustomToolRecordOperation; recordId: string | null; entity: string; expectedVersion: number; preview: boolean; data: Record<string, unknown> | null };
export type CustomToolRecordsQuery = { entity: string; preview: boolean; archived: boolean; limit: number };
export type CustomToolDashboardQuery = { view: string; preview: boolean };
export type CustomToolLinkQuery = { kind: 'STUDENT' | 'STAFF' | 'RECORD'; entity: string | null; search: string; preview: boolean };

const intIn = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
export function validateCustomToolDraftInput(v: unknown): CustomToolDraftInput {
  if (!shape(v, ['toolId', 'toolKey', 'expectedRevision', 'definition'])) fail('draft');
  const isNew = v.toolId === null;
  if ((!isNew && (typeof v.toolId !== 'string' || !UUID.test(v.toolId))) || !intIn(v.expectedRevision, 0, 999999999) || isNew !== (v.expectedRevision === 0)
    || (isNew ? typeof v.toolKey !== 'string' || !CUSTOM_TOOL_KEY.test(v.toolKey) : v.toolKey !== null)) fail('draft');
  return { toolId: v.toolId as string | null, toolKey: v.toolKey as string | null, expectedRevision: v.expectedRevision, definition: validateCustomToolDefinition(v.definition) };
}
export function validateCustomToolChangeInput(v: unknown): CustomToolChangeInput {
  if (!shape(v, ['operation', 'expectedRevision', 'version']) || !(CUSTOM_TOOL_CHANGE_OPERATIONS as readonly unknown[]).includes(v.operation)
    || !intIn(v.expectedRevision, 1, 999999999)) fail('change');
  const archive = v.operation === 'ARCHIVE' || v.operation === 'UNARCHIVE';
  if (archive ? v.version !== null : !intIn(v.version, 1, 100000)) fail('change');
  return { operation: v.operation as CustomToolChangeOperation, expectedRevision: v.expectedRevision, version: v.version as number | null };
}
export function validateCustomToolRecordInput(v: unknown): CustomToolRecordInput {
  if (!shape(v, ['operation', 'recordId', 'entity', 'expectedVersion', 'preview', 'data']) || !(CUSTOM_TOOL_RECORD_OPERATIONS as readonly unknown[]).includes(v.operation)
    || !keyOk(v.entity) || typeof v.preview !== 'boolean') fail('record input');
  const create = v.operation === 'CREATE', writes = create || v.operation === 'UPDATE';
  if (create ? v.recordId !== null || v.expectedVersion !== 0 : typeof v.recordId !== 'string' || !UUID.test(v.recordId) || !intIn(v.expectedVersion, 1, 999999999)) fail('record input');
  if (writes ? !isObj(v.data) || JSON.stringify(v.data).length > CUSTOM_TOOL_LIMITS.recordBytes : v.data !== null) fail('record input');
  return v as unknown as CustomToolRecordInput;
}
export function validateCustomToolRecordsQuery(v: unknown): CustomToolRecordsQuery {
  if (!shape(v, ['entity', 'preview', 'archived', 'limit']) || !keyOk(v.entity) || typeof v.preview !== 'boolean' || typeof v.archived !== 'boolean'
    || !intIn(v.limit, 1, CUSTOM_TOOL_LIMITS.recordsPerPage)) fail('records query');
  return v as unknown as CustomToolRecordsQuery;
}
export function validateCustomToolDashboardQuery(v: unknown): CustomToolDashboardQuery {
  if (!shape(v, ['view', 'preview']) || !keyOk(v.view) || typeof v.preview !== 'boolean') fail('dashboard query');
  return v as unknown as CustomToolDashboardQuery;
}
export function validateCustomToolLinkQuery(v: unknown): CustomToolLinkQuery {
  if (!shape(v, ['kind', 'entity', 'search', 'preview']) || !['STUDENT', 'STAFF', 'RECORD'].includes(String(v.kind)) || typeof v.search !== 'string'
    || v.search.length > 60 || CONTROL.test(v.search) || typeof v.preview !== 'boolean' || (v.kind === 'RECORD' ? !keyOk(v.entity) : v.entity !== null)) fail('link query');
  return v as unknown as CustomToolLinkQuery;
}

// ----- responses -------------------------------------------------------------------------------------------------
export type CustomToolNavEntry = { viewKey: string; label: CustomToolLabel; type: typeof CUSTOM_TOOL_VIEW_TYPES[number] };
export type CustomToolSummary = {
  toolId: string; toolKey: string; status: 'ACTIVE' | 'ARCHIVED'; revision: number; latestVersion: number; publishedVersion: number | null; draftVersion: number | null;
  name: CustomToolLabel; icon: CustomToolIcon; capabilities: CustomToolCapability[]; navigation: CustomToolNavEntry[]; updatedAt: string;
};
export type CustomToolList = { canDesign: boolean; tools: CustomToolSummary[] };
export type CustomToolVersion = { versionNo: number; status: CustomToolVersionStatus; origin: 'NEW' | 'EDIT' | 'RESTORE'; restoredFrom: number | null; createdAt: string; updatedAt: string; publishedAt: string | null };
export type CustomToolDesign = { tool: CustomToolSummary; version: CustomToolVersion & { definition: CustomToolDefinition }; versions: CustomToolVersion[]; roles: { roleId: string; name: string }[] };
export type CustomToolRecord = { recordId: string; entity: string; version: number; preview: boolean; data: Record<string, unknown>; createdAt: string; updatedAt: string; archivedAt: string | null };
export type CustomToolRecordList = { records: CustomToolRecord[]; total: number; refs: { students: Record<string, string>; staff: Record<string, string>; records: Record<string, string> }; capabilities: CustomToolCapability[] };
export type CustomToolDashboard = { view: string; cards: { key: string; label: CustomToolLabel; kind: typeof CUSTOM_TOOL_CARD_KINDS[number]; value: number | null; rows: { key: string; value: number; label: string | CustomToolLabel | null }[] | null }[] };
export type CustomToolLinkOptions = { options: { id: string; label: string }[] };

function obj(v: unknown, keys: readonly string[], what: string): Obj {
  if (!isObj(v) || Object.keys(v).sort().join(',') !== [...keys].sort().join(',')) fail(what);
  return v;
}
const time = (v: unknown, what: string): string => { if (typeof v !== 'string' || !ISO.test(v) || Number.isNaN(Date.parse(v))) fail(what); return v; };
const timeOrNull = (v: unknown, what: string): string | null => v === null ? null : time(v, what);
const uuid = (v: unknown, what: string): string => { if (typeof v !== 'string' || !UUID.test(v)) fail(what); return v; };
const intOrNull = (v: unknown, what: string): number | null => { if (v !== null && !intIn(v, 1, 100000)) fail(what); return v as number | null; };
const caps = (v: unknown): CustomToolCapability[] => {
  if (!Array.isArray(v) || !uniqueStrings(v) || !v.every(c => (CUSTOM_TOOL_CAPABILITIES as readonly unknown[]).includes(c))) fail('capabilities');
  return v as CustomToolCapability[];
};
export function verifyCustomToolSummary(v: unknown): CustomToolSummary {
  const o = obj(v, ['toolId', 'toolKey', 'status', 'revision', 'latestVersion', 'publishedVersion', 'draftVersion', 'name', 'icon', 'capabilities', 'navigation', 'updatedAt'], 'summary');
  if (typeof o.toolKey !== 'string' || !CUSTOM_TOOL_KEY.test(o.toolKey) || !['ACTIVE', 'ARCHIVED'].includes(String(o.status)) || !intIn(o.revision, 1, 999999999)
    || !intIn(o.latestVersion, 1, 100000) || !customToolLabelOk(o.name) || !(CUSTOM_TOOL_ICONS as readonly unknown[]).includes(o.icon) || !Array.isArray(o.navigation)) fail('summary');
  const navigation = o.navigation.map(n => {
    const x = obj(n, ['viewKey', 'label', 'type'], 'navigation');
    if (!keyOk(x.viewKey) || !customToolLabelOk(x.label) || !(CUSTOM_TOOL_VIEW_TYPES as readonly unknown[]).includes(x.type)) fail('navigation');
    return x as CustomToolNavEntry;
  });
  return { toolId: uuid(o.toolId, 'tool id'), toolKey: o.toolKey, status: o.status as 'ACTIVE' | 'ARCHIVED', revision: o.revision as number, latestVersion: o.latestVersion as number,
    publishedVersion: intOrNull(o.publishedVersion, 'published version'), draftVersion: intOrNull(o.draftVersion, 'draft version'), name: o.name, icon: o.icon as CustomToolIcon,
    capabilities: caps(o.capabilities), navigation, updatedAt: time(o.updatedAt, 'updated time') };
}
export function verifyCustomToolList(v: unknown): CustomToolList {
  const o = obj(v, ['canDesign', 'tools'], 'list');
  if (typeof o.canDesign !== 'boolean' || !Array.isArray(o.tools) || o.tools.length > CUSTOM_TOOL_LIMITS.toolsPerSchool) fail('list');
  return { canDesign: o.canDesign, tools: o.tools.map(verifyCustomToolSummary) };
}
function verifyVersion(v: unknown, withDefinition: boolean): CustomToolVersion & { definition?: CustomToolDefinition } {
  const keys = ['versionNo', 'status', 'origin', 'restoredFrom', 'createdAt', 'updatedAt', 'publishedAt', ...(withDefinition ? ['definition'] : [])];
  const o = obj(v, keys, 'version');
  if (!intIn(o.versionNo, 1, 100000) || !(CUSTOM_TOOL_VERSION_STATUSES as readonly unknown[]).includes(o.status) || !['NEW', 'EDIT', 'RESTORE'].includes(String(o.origin))
    || (o.origin === 'RESTORE') !== (o.restoredFrom !== null)) fail('version');
  const out: CustomToolVersion & { definition?: CustomToolDefinition } = { versionNo: o.versionNo, status: o.status as CustomToolVersionStatus, origin: o.origin as 'NEW' | 'EDIT' | 'RESTORE',
    restoredFrom: intOrNull(o.restoredFrom, 'restored from'), createdAt: time(o.createdAt, 'created time'), updatedAt: time(o.updatedAt, 'updated time'), publishedAt: timeOrNull(o.publishedAt, 'published time') };
  if ((out.status === 'PUBLISHED' || out.status === 'SUPERSEDED') !== (out.publishedAt !== null)) fail('version');
  if (withDefinition) out.definition = validateCustomToolDefinition(o.definition);
  return out;
}
export function verifyCustomToolDesign(v: unknown): CustomToolDesign {
  const o = obj(v, ['tool', 'version', 'versions', 'roles'], 'design');
  if (!Array.isArray(o.versions) || !Array.isArray(o.roles)) fail('design');
  return { tool: verifyCustomToolSummary(o.tool), version: verifyVersion(o.version, true) as CustomToolDesign['version'], versions: o.versions.map(x => verifyVersion(x, false)),
    roles: o.roles.map(r => { const x = obj(r, ['roleId', 'name'], 'role'); if (typeof x.name !== 'string' || x.name.length > 120) fail('role'); return { roleId: uuid(x.roleId, 'role id'), name: x.name }; }) };
}
export function verifyCustomToolRecord(v: unknown): CustomToolRecord {
  const o = obj(v, ['recordId', 'entity', 'version', 'preview', 'data', 'createdAt', 'updatedAt', 'archivedAt'], 'record');
  if (!keyOk(o.entity) || !intIn(o.version, 1, 999999999) || typeof o.preview !== 'boolean' || !isObj(o.data) || !Object.keys(o.data).every(k => KEY.test(k))) fail('record');
  return { recordId: uuid(o.recordId, 'record id'), entity: o.entity, version: o.version as number, preview: o.preview, data: o.data,
    createdAt: time(o.createdAt, 'created time'), updatedAt: time(o.updatedAt, 'updated time'), archivedAt: timeOrNull(o.archivedAt, 'archived time') };
}
const names = (v: unknown): Record<string, string> => {
  if (!isObj(v) || !Object.entries(v).every(([k, s]) => UUID.test(k) && typeof s === 'string' && s.length <= 120)) fail('refs');
  return v as Record<string, string>;
};
export function verifyCustomToolRecordList(v: unknown): CustomToolRecordList {
  const o = obj(v, ['records', 'total', 'refs', 'capabilities'], 'records');
  if (!Array.isArray(o.records) || o.records.length > CUSTOM_TOOL_LIMITS.recordsPerPage || !intIn(o.total, 0, 1000000)) fail('records');
  const refs = obj(o.refs, ['students', 'staff', 'records'], 'refs');
  return { records: o.records.map(verifyCustomToolRecord), total: o.total as number, refs: { students: names(refs.students), staff: names(refs.staff), records: names(refs.records) }, capabilities: caps(o.capabilities) };
}
export function verifyCustomToolDashboard(v: unknown): CustomToolDashboard {
  const o = obj(v, ['view', 'cards'], 'dashboard');
  if (!keyOk(o.view) || !Array.isArray(o.cards) || o.cards.length > CUSTOM_TOOL_LIMITS.cards) fail('dashboard');
  return { view: o.view, cards: o.cards.map(c => {
    const x = obj(c, ['key', 'label', 'kind', 'value', 'rows'], 'card');
    if (!keyOk(x.key) || !customToolLabelOk(x.label) || !(CUSTOM_TOOL_CARD_KINDS as readonly unknown[]).includes(x.kind)) fail('card');
    const board = x.kind === 'LEADERBOARD';
    if (board ? x.value !== null || !Array.isArray(x.rows) || x.rows.length > 10 : x.rows !== null || (x.value !== null && typeof x.value !== 'number')) fail('card');
    const rows = board ? (x.rows as unknown[]).map(r => { const y = obj(r, ['key', 'value', 'label'], 'row');
      if (typeof y.key !== 'string' || typeof y.value !== 'number' || !(y.label === null || typeof y.label === 'string' || customToolLabelOk(y.label))) fail('row');
      return y as { key: string; value: number; label: string | CustomToolLabel | null }; }) : null;
    return { key: x.key, label: x.label, kind: x.kind as CustomToolDashboard['cards'][number]['kind'], value: x.value as number | null, rows };
  }) };
}
export function verifyCustomToolLinkOptions(v: unknown): CustomToolLinkOptions {
  const o = obj(v, ['options'], 'link options');
  if (!Array.isArray(o.options) || o.options.length > 50) fail('link options');
  return { options: o.options.map(x => { const y = obj(x, ['id', 'label'], 'option'); if (typeof y.label !== 'string' || y.label.length > 120) fail('option'); return { id: uuid(y.id, 'option id'), label: y.label }; }) };
}
/** Text a LONG_TEXT field accepts (tabs and line breaks allowed). Exported for the record form. */
export function customToolLongTextOk(v: string, max: number): boolean { return v === v.trim() && v.length <= max && !LONG_CONTROL.test(v); }
