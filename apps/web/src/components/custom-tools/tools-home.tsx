'use client';
import React from 'react';
import type { CustomToolIcon, CustomToolList, CustomToolSummary } from '@hon/contracts';
import { ToolFrame, useToolText, type ToolContext } from './frame';
import { customToolApi, type CustomToolApi } from './http';
import { useRead, type ReadState } from './hooks';
import { labelText } from './model';
import type { T } from './copy';
import { ShellIcon, type ShellIconName } from '../school-shell/icons';
import styles from './custom-tools.module.css';

const GLYPH: Record<CustomToolIcon, ShellIconName> = { star: 'star', trophy: 'referrals', users: 'students', calendar: 'calendar', clipboard: 'clipboard', chart: 'analytics', box: 'box', flag: 'flag', heart: 'heart', shield: 'shield', bolt: 'automation', book: 'book' };
export const ToolIcon = ({ icon }: { icon: CustomToolIcon }) => <span className={styles.icon} aria-hidden="true"><ShellIcon name={GLYPH[icon] ?? 'star'} size={18}/></span>;
export const toolHref = (toolKey: string, params: Record<string, string> = {}) =>
  `/staff/tools/${encodeURIComponent(toolKey)}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`;
export const makerHref = (toolId?: string) => toolId ? `/staff/tool-maker?${new URLSearchParams({ tool: toolId })}` : '/staff/tool-maker';

/** The status of one tool for its designer, in words. */
export function toolStatus(tool: CustomToolSummary, t: T): { text: string; state: string }[] {
  const out: { text: string; state: string }[] = [];
  if (tool.status === 'ARCHIVED') out.push({ text: t('st_archived'), state: 'ARCHIVED' });
  out.push(tool.publishedVersion === null ? { text: t('st_unpublished'), state: 'DRAFT' } : { text: t('st_published', { n: String(tool.publishedVersion) }), state: 'PUBLISHED' });
  if (tool.draftVersion !== null && tool.draftVersion !== tool.publishedVersion) out.push({ text: t('st_draft', { n: String(tool.draftVersion) }), state: 'DRAFT' });
  return out;
}

export function ToolsHomeView({ list, ctx, onRefresh }: { list: ReadState<CustomToolList>; ctx: ToolContext; onRefresh: () => void }): React.ReactElement {
  const { t, language } = ctx;
  if (list.state === 'LOADING') return <p className={styles.meta} role="status">{t('loading')}</p>;
  if (list.state !== 'READY') return <p className={styles.notice} role="status">{t(list.state === 'DENIED' ? 'denied' : list.state === 'SESSION' ? 'e_SESSION' : 'unavailable')}
    {list.state === 'UNAVAILABLE' ? <button type="button" className={styles.secondary} onClick={onRefresh}>{t('tryAgain')}</button> : null}</p>;
  const { canDesign, tools } = list.value;
  // Staff see published, active tools only; a designer also sees drafts and archived tools (marked as such).
  const usable = tools.filter(tool => tool.status === 'ACTIVE' && tool.publishedVersion !== null);
  const other = canDesign ? tools.filter(tool => !usable.includes(tool)) : [];
  const tile = (tool: CustomToolSummary) => <li key={tool.toolId} className={styles.tile} data-testid="custom-tool-tile">
    <div className={styles.row}><ToolIcon icon={tool.icon}/><h3>{labelText(tool.name, language)}</h3></div>
    {canDesign ? <div className={styles.row}>{toolStatus(tool, t).map(s => <span key={s.text} className={styles.chip} data-state={s.state}>{s.text}</span>)}</div> : null}
    <div className={styles.row}>
      {tool.status === 'ACTIVE' && tool.publishedVersion !== null ? <a className={styles.primary} href={toolHref(tool.toolKey)}>{t('open')}</a> : null}
      {canDesign ? <a className={styles.secondary} href={makerHref(tool.toolId)}>{t('design')}</a> : null}
    </div>
  </li>;
  return <>
    {canDesign ? <div className={styles.row}><a className={styles.primary} href={makerHref()} data-testid="custom-tools-new">{t('newTool')}</a></div> : null}
    {usable.length ? <ul className={`${styles.tiles} ${styles.list}`} data-testid="custom-tools-live">{usable.map(tile)}</ul>
      : <p className={styles.meta}>{t(canDesign ? 'noToolsDesigner' : 'noTools')}</p>}
    {other.length ? <section className={styles.card} aria-labelledby="custom-tools-other"><h2 id="custom-tools-other">{t('yourTools')}</h2>
      <ul className={`${styles.tiles} ${styles.list}`} data-testid="custom-tools-other">{other.map(tile)}</ul></section> : null}
  </>;
}

function HomeBody({ ctx, api }: { ctx: ToolContext; api: CustomToolApi }) {
  const [list, again] = useRead((signal, owned) => api.list(ctx.scope, signal, owned), [api, ctx.scope.organizationId, ctx.scope.schoolId]);
  return <ToolsHomeView list={list} ctx={ctx} onRefresh={again}/>;
}

/** /staff/tools: the school's custom tools. The list API decides what this staff member may see. */
export function ToolsHome({ api = customToolApi }: { api?: CustomToolApi }): React.ReactElement {
  const t = useToolText();
  return <ToolFrame title={t('homeTitle')} intro={t('homeIntro')} testId="custom-tools-home">{(ctx) => <HomeBody ctx={ctx} api={api}/>}</ToolFrame>;
}
