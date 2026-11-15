'use client';
import React from 'react';
import {
  CUSTOM_TOOL_CAPABILITIES, CUSTOM_TOOL_CARD_KINDS, CUSTOM_TOOL_ICONS, CUSTOM_TOOL_LIMITS, CUSTOM_TOOL_VIEW_TYPES,
  type CustomToolCapability, type CustomToolCard, type CustomToolDefinition, type CustomToolEntity, type CustomToolField, type CustomToolFieldType, type CustomToolLabel, type CustomToolView,
} from '@hon/contracts';
import type { CustomToolKey, T } from './copy';
import { cleanLabel, defaultViews, FIELD_TYPES_IN_ORDER, isGroupable, isNumeric, labelText, makeKey, reconcile, retypeField } from './model';
import styles from './custom-tools.module.css';

/**
 * The Tool Maker's design editor. It edits a closed definition only (names, fields, screens, access); it never
 * shows or writes code. Keys stay internal: a field or kind of record that has never been saved takes its key from its
 * English name, and once saved its key (and, once published, its type) never changes.
 */
export type EditorProps = Readonly<{
  definition: CustomToolDefinition; onChange: (def: CustomToolDefinition) => void; readOnly: boolean;
  /** Field keys per entity in versions the server already holds; those keep their key, and published ones their type. */
  savedFields: ReadonlyMap<string, ReadonlySet<string>>; publishedFields: ReadonlyMap<string, ReadonlySet<string>>;
  roles: ReadonlyArray<{ roleId: string; name: string }> | null; language: string; t: T;
}>;

const swap = <X,>(list: readonly X[], i: number, j: number): X[] => { const out = [...list]; [out[i], out[j]] = [out[j]!, out[i]!]; return out; };

function LabelInputs({ label, onChange, t, disabled, title, testId, max = 80 }: { label: CustomToolLabel; onChange: (l: CustomToolLabel) => void; t: T; disabled: boolean; title: string; testId?: string; max?: number }) {
  const set = (k: 'en' | 'ko' | 'es', v: string) => onChange({ ...label, [k]: v } as CustomToolLabel);
  return <div className={styles.stack}>
    <label className={styles.field}>{title}<input value={label.en} maxLength={max} disabled={disabled} data-testid={testId} onChange={(e) => set('en', e.target.value)}/></label>
    <details className={styles.more}><summary>{t('nameKo')} · {t('nameEs')}</summary><div className={styles.grid}>
      <label className={styles.field}>{t('nameKo')}<input value={label.ko ?? ''} maxLength={max} disabled={disabled} onChange={(e) => set('ko', e.target.value)}/></label>
      <label className={styles.field}>{t('nameEs')}<input value={label.es ?? ''} maxLength={max} disabled={disabled} onChange={(e) => set('es', e.target.value)}/></label>
    </div></details>
  </div>;
}

/** Rename an internal key everywhere it is used, for a field or entity that was never saved. */
export function rekeyField(def: CustomToolDefinition, entity: string, from: string, to: string): CustomToolDefinition {
  if (from === to) return def;
  const r = (k: string) => k === from ? to : k;
  return {
    ...def,
    entities: def.entities.map(e => e.key !== entity ? e : { ...e, fields: e.fields.map(f => f.key === from ? { ...f, key: to } : f) }),
    views: def.views.map(v => v.entity !== entity ? v : {
      ...v, ...(v.columns ? { columns: v.columns.map(r) } : {}), ...(v.fields ? { fields: v.fields.map(r) } : {}),
      ...(v.sort ? { sort: { ...v.sort, field: r(v.sort.field) } } : {}),
      ...(v.cards ? { cards: v.cards.map(c => ({ ...c, ...(c.field ? { field: r(c.field) } : {}), ...(c.groupBy ? { groupBy: r(c.groupBy) } : {}) })) } : {}),
    }),
  };
}
export function rekeyEntity(def: CustomToolDefinition, from: string, to: string): CustomToolDefinition {
  if (from === to) return def;
  return {
    ...def,
    entities: def.entities.map(e => ({ ...(e.key === from ? { ...e, key: to } : e), fields: e.fields.map(f => f.entity === from ? { ...f, entity: to } : f) })),
    views: def.views.map(v => v.entity === from ? { ...v, entity: to } : v),
  };
}

function FieldEditor({ p, entity, field, index, count }: { p: EditorProps; entity: CustomToolEntity; field: CustomToolField; index: number; count: number }) {
  const { t, language, readOnly } = p;
  const published = p.publishedFields.get(entity.key)?.has(field.key) ?? false;
  const update = (f: CustomToolField) => p.onChange(reconcile({ ...p.definition, entities: p.definition.entities.map(e => e.key !== entity.key ? e : { ...e, fields: e.fields.map(x => x.key === field.key ? f : x) }) }));
  const setLabel = (label: CustomToolLabel) => p.onChange({ ...p.definition, entities: p.definition.entities.map(e => e.key !== entity.key ? e : { ...e, fields: e.fields.map(x => x.key === field.key ? { ...x, label } : x) }) });
  const move = (dir: -1 | 1) => p.onChange({ ...p.definition, entities: p.definition.entities.map(e => e.key !== entity.key ? e : { ...e, fields: swap(e.fields, index, index + dir) }) });
  const remove = () => p.onChange(reconcile({ ...p.definition, entities: p.definition.entities.map(e => e.key !== entity.key ? e : { ...e, fields: e.fields.filter(x => x.key !== field.key) }) }));
  const num = (v: string): number | undefined => v.trim() === '' || !Number.isFinite(Number(v)) ? undefined : Number(v);
  const setBound = (k: 'min' | 'max' | 'maxLength', v: string) => { const next = { ...field }; const n = num(v); if (n === undefined) delete next[k]; else next[k] = n; update(next); };
  return <li className={styles.block} data-testid={`custom-tool-field-${entity.key}-${field.key}`}>
    <div className={styles.fieldRow}>
      <LabelInputs label={field.label} onChange={setLabel} t={t} disabled={readOnly} title={t('fieldLabel')} testId="custom-tool-field-label"/>
      <label className={styles.field}>{t('fieldType')}
        <select value={field.type} disabled={readOnly || published} data-testid="custom-tool-field-type"
          onChange={(e) => update(retypeField(field, e.target.value as CustomToolFieldType, p.definition.entities, entity.key))}>
          {FIELD_TYPES_IN_ORDER.map(ft => <option key={ft} value={ft}>{t(`ft_${ft}` as CustomToolKey)}</option>)}</select></label>
      <label className={styles.check}><input type="checkbox" checked={!!field.required} disabled={readOnly}
        onChange={(e) => { const next = { ...field }; if (e.target.checked) next.required = true; else delete next.required; update(next); }}/>{t('required')}</label>
    </div>
    {published ? <p className={styles.meta}>{t('typeLocked')}</p> : null}
    {field.type === 'CHOICE' || field.type === 'MULTI_CHOICE' ? <label className={styles.field}>{t('choices')}
      <textarea rows={3} disabled={readOnly} data-testid="custom-tool-field-choices" defaultValue={(field.choices ?? []).map(c => labelText(c.label, 'en')).join('\n')}
        onBlur={(e) => {
          const names = e.target.value.split('\n').map(s => s.trim()).filter(Boolean).slice(0, CUSTOM_TOOL_LIMITS.choices);
          const old = field.choices ?? [], used: string[] = [];
          // A choice keeps its key (and its saved values) when its English name is unchanged; a new name gets a new key.
          const choices = names.map(name => { const hit = old.find(c => c.label.en === name && !used.includes(c.key));
            const key = hit?.key ?? makeKey(name, [...used, ...old.map(c => c.key)], 'option'); used.push(key); return { key, label: hit?.label ?? { en: name.slice(0, 80) } }; });
          update({ ...field, choices: choices.length ? choices : old });
        }}/></label> : null}
    {field.type === 'INTEGER' || field.type === 'NUMBER' ? <div className={styles.grid}>
      <label className={styles.field}>{t('min')}<input inputMode="decimal" disabled={readOnly} defaultValue={field.min ?? ''} onBlur={(e) => setBound('min', e.target.value)}/></label>
      <label className={styles.field}>{t('max')}<input inputMode="decimal" disabled={readOnly} defaultValue={field.max ?? ''} onBlur={(e) => setBound('max', e.target.value)}/></label></div> : null}
    {field.type === 'TEXT' || field.type === 'LONG_TEXT' ? <label className={styles.field}>{t('maxLength')}
      <input inputMode="numeric" disabled={readOnly} defaultValue={field.maxLength ?? ''} onBlur={(e) => setBound('maxLength', e.target.value)}/></label> : null}
    {field.type === 'RECORD_REF' ? <label className={styles.field}>{t('linksTo')}
      <select value={field.entity ?? ''} disabled={readOnly || published} onChange={(e) => update({ ...field, entity: e.target.value })}>
        {p.definition.entities.map(e => <option key={e.key} value={e.key}>{labelText(e.label, language)}</option>)}</select></label> : null}
    {!readOnly ? <div className={styles.row}>
      <button type="button" className={`${styles.secondary} ${styles.small}`} disabled={index === 0} onClick={() => move(-1)}>{t('moveUp')}</button>
      <button type="button" className={`${styles.secondary} ${styles.small}`} disabled={index === count - 1} onClick={() => move(1)}>{t('moveDown')}</button>
      <button type="button" className={`${styles.secondary} ${styles.small}`} disabled={count <= 1} onClick={remove}>{t('removeField')}</button>
    </div> : null}
  </li>;
}

function EntityEditor({ p, entity }: { p: EditorProps; entity: CustomToolEntity }) {
  const { t, readOnly } = p;
  const setLabel = (label: CustomToolLabel) => p.onChange({ ...p.definition, entities: p.definition.entities.map(e => e.key === entity.key ? { ...e, label } : e) });
  const addField = () => p.onChange({ ...p.definition, entities: p.definition.entities.map(e => e.key !== entity.key ? e
    : { ...e, fields: [...e.fields, { key: makeKey('new_field', e.fields.map(f => f.key)), label: { en: 'New field' }, type: 'TEXT' as const }] }) });
  const remove = () => p.onChange(reconcile({ ...p.definition, entities: p.definition.entities.filter(e => e.key !== entity.key) }));
  return <section className={styles.block} data-testid={`custom-tool-entity-${entity.key}`}>
    <LabelInputs label={entity.label} onChange={setLabel} t={t} disabled={readOnly} title={t('entityLabel')} testId="custom-tool-entity-label"/>
    <h4>{t('fieldsTitle')}</h4>
    <ol className={`${styles.list} ${styles.stack}`}>{entity.fields.map((f, i) => <FieldEditor key={f.key} p={p} entity={entity} field={f} index={i} count={entity.fields.length}/>)}</ol>
    {!readOnly ? <div className={styles.row}>
      <button type="button" className={styles.secondary} disabled={entity.fields.length >= CUSTOM_TOOL_LIMITS.fieldsPerEntity} onClick={addField} data-testid="custom-tool-add-field">{t('addField')}</button>
      <button type="button" className={styles.secondary} disabled={p.definition.entities.length <= 1} onClick={remove}>{t('removeEntity')}</button>
    </div> : null}
  </section>;
}

function FieldChecks({ p, entity, picked, max, onChange, testId }: { p: EditorProps; entity: CustomToolEntity; picked: readonly string[]; max: number; onChange: (keys: string[]) => void; testId: string }) {
  return <div className={styles.checks} data-testid={testId}>{entity.fields.map(f => <label key={f.key} className={styles.check}>
    <input type="checkbox" disabled={p.readOnly || (!picked.includes(f.key) && picked.length >= max)} checked={picked.includes(f.key)}
      onChange={(e) => onChange(e.target.checked ? entity.fields.map(x => x.key).filter(k => k === f.key || picked.includes(k)) : picked.filter(k => k !== f.key))}/>
    {labelText(f.label, p.language)}</label>)}</div>;
}

function CardEditor({ p, view, entity, card, onCard, onRemove }: { p: EditorProps; view: CustomToolView; entity: CustomToolEntity; card: CustomToolCard; onCard: (c: CustomToolCard) => void; onRemove: () => void }) {
  const { t, language, readOnly } = p;
  const numeric = entity.fields.filter(isNumeric), groups = entity.fields.filter(isGroupable);
  const setKind = (kind: CustomToolCard['kind']) => {
    const base: CustomToolCard = { key: card.key, label: card.label, kind };
    if (kind !== 'COUNT') base.field = card.field && numeric.some(f => f.key === card.field) ? card.field : numeric[0]?.key ?? '';
    if (kind === 'LEADERBOARD') base.groupBy = card.groupBy && groups.some(f => f.key === card.groupBy) ? card.groupBy : groups[0]?.key ?? '';
    onCard(base);
  };
  return <li className={styles.block} data-testid={`custom-tool-card-editor-${view.key}-${card.key}`}>
    <LabelInputs label={card.label} onChange={(label) => onCard({ ...card, label })} t={t} disabled={readOnly} title={t('cardLabel')}/>
    <div className={styles.grid}>
      <label className={styles.field}>{t('cardKind')}<select value={card.kind} disabled={readOnly} onChange={(e) => setKind(e.target.value as CustomToolCard['kind'])}>
        {CUSTOM_TOOL_CARD_KINDS.map(k => <option key={k} value={k} disabled={k !== 'COUNT' && !numeric.length || k === 'LEADERBOARD' && !groups.length}>{t(`ck_${k}` as CustomToolKey)}</option>)}</select></label>
      {card.kind !== 'COUNT' ? <label className={styles.field}>{t('cardField')}<select value={card.field ?? ''} disabled={readOnly} onChange={(e) => onCard({ ...card, field: e.target.value })}>
        {numeric.map(f => <option key={f.key} value={f.key}>{labelText(f.label, language)}</option>)}</select></label> : null}
      {card.kind === 'LEADERBOARD' ? <label className={styles.field}>{t('cardGroup')}<select value={card.groupBy ?? ''} disabled={readOnly} onChange={(e) => onCard({ ...card, groupBy: e.target.value })}>
        {groups.map(f => <option key={f.key} value={f.key}>{labelText(f.label, language)}</option>)}</select></label> : null}
    </div>
    {!readOnly ? <button type="button" className={`${styles.secondary} ${styles.small}`} disabled={(view.cards?.length ?? 0) <= 1} onClick={onRemove}>{t('removeCard')}</button> : null}
  </li>;
}

function ViewEditor({ p, view, index }: { p: EditorProps; view: CustomToolView; index: number }) {
  const { t, language, readOnly } = p;
  const def = p.definition, entity = def.entities.find(e => e.key === view.entity)!;
  const set = (v: CustomToolView) => p.onChange(reconcile({ ...def, views: def.views.map((x, i) => i === index ? v : x) }));
  const shape = (type: CustomToolView['type'], entityKey: string): CustomToolView => {
    const e = def.entities.find(x => x.key === entityKey)!;
    const base = { key: view.key, label: view.label, entity: entityKey };
    if (type === 'TABLE') return { ...base, type, columns: e.fields.slice(0, 6).map(f => f.key) };
    if (type === 'FORM') return { ...base, type, fields: e.fields.map(f => f.key) };
    return { ...base, type, cards: [{ key: 'count', label: { en: 'Records' }, kind: 'COUNT' }] };
  };
  const inMenu = def.navigation.includes(view.key);
  const cards = view.cards ?? [];
  return <li className={styles.block} data-testid={`custom-tool-view-editor-${view.key}`}>
    <LabelInputs label={view.label} onChange={(label) => set({ ...view, label })} t={t} disabled={readOnly} title={t('viewLabel')}/>
    <div className={styles.grid}>
      <label className={styles.field}>{t('viewType')}<select value={view.type} disabled={readOnly} onChange={(e) => set(shape(e.target.value as CustomToolView['type'], view.entity))}>
        {CUSTOM_TOOL_VIEW_TYPES.map(vt => <option key={vt} value={vt}>{t(`vt_${vt}` as CustomToolKey)}</option>)}</select></label>
      <label className={styles.field}>{t('viewEntity')}<select value={view.entity} disabled={readOnly} onChange={(e) => set(shape(view.type, e.target.value))}>
        {def.entities.map(e => <option key={e.key} value={e.key}>{labelText(e.label, language)}</option>)}</select></label>
      <label className={styles.check}><input type="checkbox" checked={inMenu} disabled={readOnly || (!inMenu && def.navigation.length >= CUSTOM_TOOL_LIMITS.navigation)}
        data-testid="custom-tool-view-in-menu"
        onChange={(e) => p.onChange({ ...def, navigation: e.target.checked ? def.views.map(v => v.key).filter(k => k === view.key || def.navigation.includes(k)) : def.navigation.filter(k => k !== view.key) })}/>{t('inMenu')}</label>
    </div>
    {view.type === 'TABLE' ? <>
      <h4>{t('columns')}</h4>
      <FieldChecks p={p} entity={entity} picked={view.columns ?? []} max={CUSTOM_TOOL_LIMITS.columns} testId="custom-tool-view-columns" onChange={(columns) => set({ ...view, columns })}/>
      <div className={styles.grid}>
        <label className={styles.field}>{t('sortBy')}<select value={view.sort?.field ?? ''} disabled={readOnly} onChange={(e) => {
          const next = { ...view }; if (e.target.value) next.sort = { field: e.target.value, direction: view.sort?.direction ?? 'DESC' }; else delete next.sort; set(next); }}>
          <option value="">{t('sortNone')}</option>{entity.fields.map(f => <option key={f.key} value={f.key}>{labelText(f.label, language)}</option>)}</select></label>
        {view.sort ? <label className={styles.field}>&nbsp;<select value={view.sort.direction} disabled={readOnly} onChange={(e) => set({ ...view, sort: { field: view.sort!.field, direction: e.target.value as 'ASC' | 'DESC' } })}>
          <option value="ASC">{t('asc')}</option><option value="DESC">{t('desc')}</option></select></label> : null}
      </div></> : null}
    {view.type === 'FORM' ? <><h4>{t('formFields')}</h4>
      <FieldChecks p={p} entity={entity} picked={view.fields ?? []} max={CUSTOM_TOOL_LIMITS.fieldsPerEntity} testId="custom-tool-view-fields" onChange={(fields) => set({ ...view, fields })}/></> : null}
    {view.type === 'DASHBOARD' ? <><h4>{t('cards')}</h4>
      <ul className={`${styles.list} ${styles.stack}`}>{cards.map((c, i) => <CardEditor key={c.key} p={p} view={view} entity={entity} card={c}
        onCard={(card) => set({ ...view, cards: cards.map((x, j) => j === i ? card : x) })} onRemove={() => set({ ...view, cards: cards.filter((_, j) => j !== i) })}/>)}</ul>
      {!readOnly ? <button type="button" className={`${styles.secondary} ${styles.small}`} disabled={cards.length >= CUSTOM_TOOL_LIMITS.cards}
        onClick={() => set({ ...view, cards: [...cards, { key: makeKey('card', cards.map(c => c.key)), label: { en: 'Records' }, kind: 'COUNT' }] })}>{t('addCard')}</button> : null}</> : null}
    {!readOnly ? <button type="button" className={`${styles.secondary} ${styles.small}`} disabled={def.views.length <= 1}
      onClick={() => p.onChange(reconcile({ ...def, views: def.views.filter((_, i) => i !== index) }))}>{t('removeView')}</button> : null}
  </li>;
}

function AccessEditor({ p }: { p: EditorProps }) {
  const { t, readOnly } = p, def = p.definition;
  if (p.roles === null) return <p className={styles.meta}>{t('accessAfterSave')}</p>;
  if (!p.roles.length) return <p className={styles.meta}>{t('noRoles')}</p>;
  const setCaps = (roleId: string, caps: CustomToolCapability[]) => {
    const rest = def.access.filter(a => a.roleId !== roleId);
    // Every other capability needs "See"; ticking any of them also ticks it.
    const full = caps.length && !caps.includes('VIEW') ? ['VIEW' as const, ...caps] : caps;
    const ordered = CUSTOM_TOOL_CAPABILITIES.filter(c => full.includes(c));
    p.onChange({ ...def, access: ordered.length ? [...rest, { roleId, capabilities: ordered }] : rest });
  };
  return <div className={styles.tableWrap}><table className={styles.table} data-testid="custom-tool-access">
    <thead><tr><th scope="col">&nbsp;</th>{CUSTOM_TOOL_CAPABILITIES.map(c => <th key={c} scope="col">{t(`cap_${c}` as CustomToolKey)}</th>)}</tr></thead>
    <tbody>{p.roles.map(r => { const caps = def.access.find(a => a.roleId === r.roleId)?.capabilities ?? [];
      return <tr key={r.roleId}><th scope="row">{r.name}</th>{CUSTOM_TOOL_CAPABILITIES.map(c => <td key={c}><input type="checkbox" aria-label={`${r.name}: ${t(`cap_${c}` as CustomToolKey)}`}
        checked={caps.includes(c)} disabled={readOnly || (!caps.length && def.access.length >= CUSTOM_TOOL_LIMITS.accessRules)}
        onChange={(e) => setCaps(r.roleId, e.target.checked ? [...caps, c] : c === 'VIEW' ? [] : caps.filter(x => x !== c))}/></td>)}</tr>; })}</tbody>
  </table></div>;
}

export function DesignEditor(p: EditorProps): React.ReactElement {
  const { t, language, readOnly } = p, def = p.definition;
  const addEntity = () => {
    const key = makeKey('new_record', def.entities.map(e => e.key), 'record');
    const entity: CustomToolEntity = { key, label: { en: 'New record' }, fields: [{ key: 'title', label: { en: 'Title' }, type: 'TEXT', required: true }] };
    const views = defaultViews(entity, def.views.map(v => v.key));
    p.onChange({ ...def, entities: [...def.entities, entity], views: [...def.views, ...views],
      navigation: def.navigation.length < CUSTOM_TOOL_LIMITS.navigation ? [...def.navigation, views[0]!.key] : def.navigation });
  };
  const addView = () => {
    const entity = def.entities[0]!;
    const key = makeKey(`${entity.key}_view`, def.views.map(v => v.key));
    p.onChange({ ...def, views: [...def.views, { key, label: { en: 'New screen' }, type: 'TABLE', entity: entity.key, columns: entity.fields.slice(0, 6).map(f => f.key) }] });
  };
  const setDescription = (en: string) => { const next = { ...def }; if (en.trim()) next.description = { ...(def.description ?? {}), en }; else delete next.description; p.onChange(next); };
  return <div className={styles.stack} data-testid="custom-tool-editor">
    <section className={styles.card} aria-labelledby="ct-basics"><h2 id="ct-basics">{t('basicsTitle')}</h2>
      <LabelInputs label={def.name} onChange={(name) => p.onChange({ ...def, name })} t={t} disabled={readOnly} title={t('nameEn')} testId="custom-tool-name"/>
      <label className={styles.field}>{t('descriptionEn')}<textarea rows={2} maxLength={400} disabled={readOnly} value={def.description?.en ?? ''} onChange={(e) => setDescription(e.target.value)}/></label>
      <label className={styles.field}>{t('icon')}<select value={def.icon} disabled={readOnly} onChange={(e) => p.onChange({ ...def, icon: e.target.value as CustomToolDefinition['icon'] })}>
        {CUSTOM_TOOL_ICONS.map(i => <option key={i} value={i}>{t(`icon_${i}` as CustomToolKey)}</option>)}</select></label>
    </section>
    <section className={styles.card} aria-labelledby="ct-entities"><h2 id="ct-entities">{t('entitiesTitle')}</h2><p className={styles.meta}>{t('entitiesHelp')}</p>
      {def.entities.map(e => <EntityEditor key={e.key} p={p} entity={e}/>)}
      {!readOnly ? <div className={styles.row}><button type="button" className={styles.secondary} disabled={def.entities.length >= CUSTOM_TOOL_LIMITS.entities} onClick={addEntity}>{t('addEntity')}</button></div> : null}
    </section>
    <section className={styles.card} aria-labelledby="ct-views"><h2 id="ct-views">{t('viewsTitle')}</h2><p className={styles.meta}>{t('viewsHelp')}</p>
      <ol className={`${styles.list} ${styles.stack}`}>{def.views.map((v, i) => <ViewEditor key={v.key} p={p} view={v} index={i}/>)}</ol>
      {!readOnly ? <div className={styles.row}><button type="button" className={styles.secondary} disabled={def.views.length >= CUSTOM_TOOL_LIMITS.views} onClick={addView}>{t('addView')}</button></div> : null}
    </section>
    <section className={styles.card} aria-labelledby="ct-access"><h2 id="ct-access">{t('accessTitle')}</h2><p className={styles.meta}>{t('accessHelp')}</p><AccessEditor p={p}/></section>
    <span hidden>{labelText(def.name, language)}</span>
  </div>;
}

/** The English-required label rule, applied before saving so an empty Korean or Spanish name is simply left out. */
export function tidyDefinition(def: CustomToolDefinition): CustomToolDefinition {
  const l = (x: CustomToolLabel, fallback: string) => cleanLabel(x, fallback);
  const out: CustomToolDefinition = {
    ...def, name: l(def.name, ''),
    entities: def.entities.map(e => ({ ...e, label: l(e.label, ''), fields: e.fields.map(f => ({ ...f, label: l(f.label, ''), ...(f.choices ? { choices: f.choices.map(c => ({ ...c, label: l(c.label, '') })) } : {}) })) })),
    views: def.views.map(v => ({ ...v, label: l(v.label, ''), ...(v.cards ? { cards: v.cards.map(c => ({ ...c, label: l(c.label, '') })) } : {}) })),
  };
  if (def.description) { const d = cleanLabel(def.description); if (d.en) out.description = d; else delete out.description; }
  return out;
}

/**
 * Keys for parts the server has never held, taken from their English names just before saving, so stored data and
 * automations read "points" rather than "new_field_2". Saved keys never change.
 */
export function finalizeKeys(def: CustomToolDefinition, saved: ReadonlyMap<string, ReadonlySet<string>>): CustomToolDefinition {
  let out = def;
  for (const e of def.entities) {
    if (saved.has(e.key) || !e.label.en.trim()) continue;
    const key = makeKey(e.label.en, out.entities.map(x => x.key).filter(k => k !== e.key), 'record');
    out = rekeyEntity(out, e.key, key);
  }
  for (const e of out.entities) {
    const kept = saved.get(e.key);
    for (const f of e.fields) {
      if (kept?.has(f.key) || !f.label.en.trim()) continue;
      const current = out.entities.find(x => x.key === e.key)!;
      const key = makeKey(f.label.en, current.fields.map(x => x.key).filter(k => k !== f.key), 'field');
      out = rekeyField(out, e.key, f.key, key);
    }
  }
  return out;
}
