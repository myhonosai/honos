import type { CustomToolCapability, CustomToolDefinition } from '@hon/contracts';
import type { CustomToolKey, T } from './copy';
import { labelText } from './model';

/**
 * A design in plain sentences, so an owner reviews what the tool keeps, which screens it has and who can use it before
 * anything is saved or published. Derived only from the definition and the school's role names; it states no outcome.
 */
export function describeDesign(def: CustomToolDefinition, roles: ReadonlyArray<{ roleId: string; name: string }>, language: string, t: T): string[] {
  const label = (l: Parameters<typeof labelText>[0]) => labelText(l, language);
  const entityName = (key: string) => label(def.entities.find(e => e.key === key)?.label);
  const out = [t('rv_keeps', { list: def.entities.map(e => label(e.label)).join(', ') })];
  for (const e of def.entities) {
    const fields = e.fields.map(f => {
      const notes = [t(`ft_${f.type}` as CustomToolKey)];
      if (f.type === 'RECORD_REF' && f.entity) notes.push(t('rv_links', { entity: entityName(f.entity) }));
      if (f.required) notes.push(t('rv_required'));
      return `${label(f.label)} (${notes.join(', ')})`;
    });
    out.push(t('rv_entity', { entity: label(e.label), fields: fields.join('; ') }));
  }
  out.push(t('rv_screens', { list: def.views.map(v => `${label(v.label)} (${t(`vt_${v.type}` as CustomToolKey)})`).join(', ') }));
  const tabs = def.navigation.map(k => label(def.views.find(v => v.key === k)?.label)).filter(Boolean);
  out.push(tabs.length ? t('rv_tabs', { list: tabs.join(', ') }) : t('rv_noTabs'));
  if (!def.access.length) out.push(t('rv_accessNone'));
  for (const a of def.access) {
    const role = roles.find(r => r.roleId === a.roleId)?.name;
    if (!role) continue;
    out.push(t('rv_access', { role, caps: a.capabilities.map((c: CustomToolCapability) => t(`cap_${c}` as CustomToolKey).toLowerCase()).join(', ') }));
  }
  out.push(t('rv_safe'));
  return out;
}
