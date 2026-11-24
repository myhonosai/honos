import React, { useEffect, useState } from 'react';
import type { ShopifyStorefront, ShopifyStorefrontLinks, ShopifyStorefrontPublishResult, ShopifyStorefrontSettings } from '@hon/contracts';
import type { ShopifyErrorKind } from './http';
import { storefrontText, type StorefrontKey } from './storefront-copy';
import styles from './shopify.module.css';

// ---- Storefront blocks TB2 (Commerce step 4). HON's theme app extension: the owner places blocks in Shopify's theme editor. ----

export type StorefrontCommand = Readonly<{ kind: 'SAVE'; settings: ShopifyStorefrontSettings } | { kind: 'PUBLISH' }>;
export type StorefrontState = { state: 'LOADING' | 'UNAVAILABLE' } | { state: 'READY'; value: ShopifyStorefront };
/** The last storefront command: in flight, its verified answer, or why it was refused. */
export type StorefrontOutcome = null | Readonly<{ kind: 'SENDING'; command: StorefrontCommand }
  | { kind: 'SAVED'; command: StorefrontCommand } | { kind: 'PUBLISHED'; command: StorefrontCommand; result: ShopifyStorefrontPublishResult }
  | { kind: 'ERROR'; command: StorefrontCommand; error: ShopifyErrorKind }>;

const HEX = /^#[0-9A-F]{6}$/;
/** A brand color as the contract wants it (#RRGGBB, upper case), or a neutral default. */
export function storefrontColor(v: string | null | undefined, fallback = '#121212'): string {
  const c = (v ?? '').trim().toUpperCase();
  return HEX.test(c) ? c : /^#[0-9A-F]{3}$/.test(c) ? '#' + c.slice(1).split('').map(x => x + x).join('') : fallback;
}
const orNull = (v: string) => { const t = v.trim(); return t.length ? t : null; };

export type StorefrontViewProps = Readonly<{
  language: string; canManage: boolean; storefront: StorefrontState; outcome: StorefrontOutcome; locked: boolean;
  brandColor: string | null; onCommand: (c: StorefrontCommand) => void;
}>;

const LINKS: readonly (keyof ShopifyStorefrontLinks)[] = ['colors', 'sizeGuide', 'pickupNote', 'pickupBanner'];

/** Pure view of the verified storefront. Save keeps settings in HON; Publish sends one saved version; the links open Shopify. */
export function StorefrontBlocks(p: StorefrontViewProps): React.ReactElement {
  const t = (k: StorefrontKey, v?: Record<string, string>) => storefrontText(p.language, k, v);
  const saved = p.storefront.state === 'READY' ? p.storefront.value.settings : null;
  const savedVersion = p.storefront.state === 'READY' ? p.storefront.value.settingsVersion : null;
  const [primary, setPrimary] = useState(() => storefrontColor(saved?.primaryColor ?? p.brandColor));
  const [useAccent, setUseAccent] = useState(!!saved?.accentColor);
  const [accent, setAccent] = useState(saved?.accentColor ?? '#FFFFFF');
  const [sizeTitle, setSizeTitle] = useState(saved?.sizeGuideTitle ?? '');
  const [sizeText, setSizeText] = useState(saved?.sizeGuideText ?? '');
  const [pickup, setPickup] = useState(saved?.pickupNote ?? '');
  // A new saved version (loaded, saved here or by someone else) resets the form to it.
  useEffect(() => {
    if (!saved) { if (p.brandColor) setPrimary(storefrontColor(p.brandColor)); return; }
    setPrimary(saved.primaryColor); setUseAccent(saved.accentColor !== null); setAccent(saved.accentColor ?? '#FFFFFF');
    setSizeTitle(saved.sizeGuideTitle ?? ''); setSizeText(saved.sizeGuideText ?? ''); setPickup(saved.pickupNote ?? '');
  }, [savedVersion, p.brandColor]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!p.canManage) return <div className={styles.card} data-section="theme"><p className={styles.meta}>{t('sf_managerOnly')}</p></div>;
  if (p.storefront.state !== 'READY') return <div className={styles.card} data-section="theme" role={p.storefront.state === 'LOADING' ? 'status' : 'alert'}>
    <p className={styles.meta}>{t(p.storefront.state === 'LOADING' ? 'sf_loading' : 'sf_e_other')}</p></div>;
  const s = p.storefront.value, o = p.outcome, sending = o?.kind === 'SENDING';
  const intro = <div className={styles.card}><h2>{t('sf_title')}</h2><p className={styles.meta}>{t('sf_intro')}</p></div>;
  if (!s.connected) return <div className={styles.section} data-section="theme">{intro}<div className={styles.card}><p className={styles.meta}>{t('sf_notConnected')}</p></div></div>;

  const settings: ShopifyStorefrontSettings = { primaryColor: primary, accentColor: useAccent ? accent : null,
    sizeGuideTitle: orNull(sizeTitle), sizeGuideText: orNull(sizeText), pickupNote: orNull(pickup) };
  const titleWithoutText = settings.sizeGuideTitle !== null && settings.sizeGuideText === null;
  const valid = HEX.test(primary) && (!useAccent || HEX.test(accent)) && !titleWithoutText;
  const changed = !saved || JSON.stringify(saved) !== JSON.stringify(settings);
  const busy = (kind: StorefrontCommand['kind']) => sending && o.command.kind === kind;
  const behind = s.settingsVersion !== null && s.publishedVersion !== s.settingsVersion;

  let message: React.ReactNode = null;
  if (o?.kind === 'SAVED') message = <div className={styles.notice} role="status" data-storefront-outcome="SAVED"><p>{t('sf_saved')}</p></div>;
  else if (o?.kind === 'PUBLISHED') {
    const r = o.result, code = r.failureCode ?? '', good = r.outcome === 'PUBLISHED';
    const key: StorefrontKey = good ? 'sf_done_PUBLISHED' : r.outcome === 'UNKNOWN' ? 'sf_unknown' : code === 'TOKEN_REJECTED' ? 'sf_f_TOKEN_REJECTED' : 'sf_failed';
    message = <div className={`${styles.notice} ${good ? '' : styles.warn}`} role={good ? 'status' : 'alert'} data-storefront-outcome={r.outcome}><p>{t(key, { code })}</p></div>;
  } else if (o?.kind === 'ERROR') {
    const e = o.error;
    const key: StorefrontKey = e === 'STOREFRONT_BUSY' || e === 'STOREFRONT_DONE' || e === 'STOREFRONT_LIMIT' || e === 'STALE' ? `sf_e_${e}`
      : e === 'NOT_CONNECTED' && o.command.kind === 'PUBLISH' ? 'sf_saveFirst' : e === 'UNKNOWN' ? 'sf_e_lost' : 'sf_e_other';
    message = <div className={`${styles.notice} ${styles.warn}`} role="alert" data-storefront-outcome="ERROR"><p>{t(key)}</p></div>;
  }

  const colorField = (label: string, value: string, set: (v: string) => void, name: string) => <div className={styles.field}>{label}
    <span className={styles.colorRow}><input type="color" value={value.toLowerCase()} onChange={(e) => set(storefrontColor(e.target.value))} disabled={p.locked} className={styles.swatch} aria-label={label} />
      <input value={value} onChange={(e) => set(e.target.value.toUpperCase())} disabled={p.locked} maxLength={7} spellCheck={false} className={styles.hex} aria-label={label} data-storefront-input={name} /></span></div>;

  return <div className={styles.section} data-section="theme">
    {intro}
    {message}
    <div className={styles.card} data-storefront-step="settings">
      <h2>{t('sf_step1')}</h2>
      <p className={styles.meta}>{t('sf_step1d')}</p>
      <form className={styles.form} onSubmit={(e) => { e.preventDefault(); if (valid && changed && !p.locked) p.onCommand({ kind: 'SAVE', settings }); }}>
        <div className={styles.row}>
          {colorField(t('sf_primary'), primary, setPrimary, 'primary')}
          {useAccent && colorField(t('sf_accent'), accent, setAccent, 'accent')}
        </div>
        <label className={styles.check}><input type="checkbox" checked={useAccent} onChange={(e) => setUseAccent(e.target.checked)} disabled={p.locked} />{t('sf_useAccent')}</label>
        {p.brandColor && !saved && <p className={styles.meta}>{t('sf_brandHint')}</p>}
        <label className={styles.field}>{t('sf_sizeTitle')}
          <input value={sizeTitle} onChange={(e) => setSizeTitle(e.target.value)} maxLength={60} disabled={p.locked} data-storefront-input="sizeTitle" />
          <span className={styles.meta}>{t('sf_sizeTitleHint')}</span></label>
        <label className={styles.field}>{t('sf_sizeText')}
          <textarea rows={5} value={sizeText} onChange={(e) => setSizeText(e.target.value)} maxLength={2000} disabled={p.locked} data-storefront-input="sizeText" />
          <span className={styles.meta}>{t('sf_sizeHint')}</span></label>
        <label className={styles.field}>{t('sf_pickup')}
          <textarea rows={3} value={pickup} onChange={(e) => setPickup(e.target.value)} maxLength={500} disabled={p.locked} data-storefront-input="pickup" />
          <span className={styles.meta}>{t('sf_pickupHint')}</span></label>
        {titleWithoutText && <p className={`${styles.meta} ${styles.warn}`} role="alert">{t('sf_titleNeedsText')}</p>}
        <div className={styles.row}>
          <button type="submit" className={styles.secondary} disabled={p.locked || !valid || !changed} data-storefront-action="save">{busy('SAVE') ? t('sf_saving') : t('sf_save')}</button>
        </div>
      </form>
    </div>
    <div className={styles.card} data-storefront-step="publish">
      <div className={styles.cardHead}><h2>{t('sf_step2')}</h2>
        <span className={styles.chip} data-state={s.publishStatus === 'PUBLISHED' ? 'COMPLETE' : s.publishStatus === 'NEVER' || s.publishStatus === 'FAILED' ? 'UNAVAILABLE' : 'IN_PROGRESS'}
          data-storefront-status={s.publishStatus}>{t(`sf_s_${s.publishStatus}`)}</span></div>
      <p className={styles.meta}>{t('sf_step2d')}</p>
      {s.publishedVersion !== null && <p className={styles.meta}>{t('sf_live', { live: String(s.publishedVersion) })}</p>}
      {behind && s.publishedVersion !== null && <p className={styles.meta} data-storefront-behind>{t('sf_behind')}</p>}
      {s.settingsVersion === null && <p className={styles.meta}>{t('sf_saveFirst')}</p>}
      <div className={styles.row}>
        <button type="button" className={styles.primary} disabled={p.locked || s.busy || s.settingsVersion === null || changed} data-storefront-action="publish"
          onClick={() => p.onCommand({ kind: 'PUBLISH' })}>{busy('PUBLISH') || s.busy ? t('sf_publishing') : t('sf_publish')}</button>
      </div>
    </div>
    <div className={styles.card} data-storefront-step="blocks">
      <h2>{t('sf_step3')}</h2>
      <p className={styles.meta}>{t('sf_step3d')}</p>
      {s.links && <ul className={styles.list}>{LINKS.map(k => <li key={k} data-storefront-link={k}>
        <a className={styles.secondary} href={s.links![k]} target="_blank" rel="noopener noreferrer">{t(`sf_l_${k}`)}</a>
        <span className={styles.meta}>{t(`sf_ld_${k}`)}</span></li>)}</ul>}
      <p className={styles.meta}>{t('sf_extensionNote')}</p>
    </div>
  </div>;
}
