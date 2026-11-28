'use client';
import React, { useEffect, useState } from 'react';
import type { HqSupportAlerts } from '@hon/contracts';
import { HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { supportText } from './copy';
import { SupportError, supportApi, type SupportApi } from './http';
import styles from '../hq-access/hq-access.module.css';

/**
 * 0713 HQ alerts: how many school requests wait for an HQ reply. One shared reader for every badge on the page, read
 * when the first badge mounts, every minute while HQ is open, and again when the tab comes back. When the count goes up
 * and this browser allows notifications, one desktop notice names the school and subject (never the school's words).
 * A person without HQ support access gets DENIED once and the reader stops. A session end clears it. Nothing is sent.
 */
export const ALERT_POLL_MS = 60_000;
type Listener = (alerts: HqSupportAlerts | null) => void;
type Store = { current: HqSupportAlerts | null; listeners: Set<Listener>; timer: ReturnType<typeof setInterval> | null; stopped: boolean; inFlight: boolean; generation: number };
const store: Store = { current: null, listeners: new Set(), timer: null, stopped: false, inFlight: false, generation: 0 };
let api: SupportApi = supportApi;
let language = 'en';

/** Test seam: the reader and a clean store. */
export function resetSupportAlertsForTest(next: SupportApi = supportApi): void {
  if (store.timer) clearInterval(store.timer);
  Object.assign(store, { current: null, timer: null, stopped: false, inFlight: false, generation: store.generation + 1 });
  store.listeners.clear(); api = next;
}

function publish(next: HqSupportAlerts | null) { store.current = next; for (const l of store.listeners) l(next); }

/** A desktop notice only when the count rose since the last verified read, and only when the browser already allows it. */
export function notifyIfNew(previous: HqSupportAlerts | null, next: HqSupportAlerts, lang = language): boolean {
  if (!previous || next.needsReply <= previous.needsReply) return false;
  const N = (globalThis as { Notification?: { permission?: string; new (title: string, options?: object): { onclick: (() => void) | null } } }).Notification;
  if (!N || N.permission !== 'granted') return false;
  const known = new Set(previous.latest.map((a) => a.caseId));
  const fresh = next.latest.find((a) => !known.has(a.caseId)) ?? next.latest[0];
  if (!fresh) return false;
  try {
    const n = new N(supportText(lang, 'alertTitle'), { body: supportText(lang, 'alertBody', { school: fresh.schoolDisplayName, subject: fresh.subject }), tag: `hq-support-${fresh.caseId}` });
    n.onclick = () => { try { window.focus(); window.location.assign(`/hq/support/${fresh.caseId}`); } catch { /* the notice is a convenience */ } };
    return true;
  } catch { return false; }
}

export async function readSupportAlertsNow(): Promise<void> {
  if (store.stopped || store.inFlight) return;
  store.inFlight = true; const generation = store.generation;
  try {
    const next = await api.alerts(AbortSignal.timeout(15000), () => generation === store.generation);
    if (generation !== store.generation) return;
    notifyIfNew(store.current, next);
    publish(next);
  } catch (error) {
    if (generation !== store.generation) return;
    if (error instanceof SupportError && (error.kind === 'DENIED' || error.kind === 'SESSION')) { store.stopped = true; if (store.timer) clearInterval(store.timer); store.timer = null; publish(null); }
  } finally { if (generation === store.generation) store.inFlight = false; }
}

function onVisible() { if (typeof document !== 'undefined' && document.visibilityState === 'visible') void readSupportAlertsNow(); }
function onSessionEnd() { store.generation++; store.stopped = true; store.inFlight = false; if (store.timer) clearInterval(store.timer); store.timer = null; publish(null); }

function subscribe(listener: Listener): () => void {
  store.listeners.add(listener);
  if (store.listeners.size === 1 && !store.stopped) {
    void readSupportAlertsNow();
    store.timer = setInterval(() => { void readSupportAlertsNow(); }, ALERT_POLL_MS);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    if (typeof window !== 'undefined') window.addEventListener(HON_SESSION_INVALIDATED_EVENT, onSessionEnd);
  }
  return () => {
    store.listeners.delete(listener);
    if (store.listeners.size === 0) {
      if (store.timer) clearInterval(store.timer); store.timer = null;
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
      if (typeof window !== 'undefined') window.removeEventListener(HON_SESSION_INVALIDATED_EVENT, onSessionEnd);
    }
  };
}

export function useSupportAlerts(lang = 'en'): HqSupportAlerts | null {
  const [alerts, setAlerts] = useState<HqSupportAlerts | null>(store.current);
  useEffect(() => { language = lang; return subscribe(setAlerts); }, [lang]);
  return alerts;
}

/** The count beside Messages & Support and Support in the HQ menu. Nothing shows at zero or without support access. */
export function HqSupportBadge({ language: lang = 'en' }: { language?: string }): React.ReactElement | null {
  const alerts = useSupportAlerts(lang);
  if (!alerts || alerts.needsReply === 0) return null;
  const n = alerts.needsReply > 99 ? '99+' : String(alerts.needsReply);
  return <span className={styles.status} data-tone="waiting" data-hq-support-badge={alerts.needsReply} aria-label={supportText(lang, 'needsReplyBanner', { count: String(alerts.needsReply) })}
    style={{ marginLeft: 'auto', minWidth: 22, justifyContent: 'center' }}>{n}</span>;
}

type Permission = 'unsupported' | 'default' | 'granted' | 'denied';
const permissionNow = (): Permission => {
  const N = (globalThis as { Notification?: { permission?: string } }).Notification;
  const p = N?.permission;
  return p === 'granted' || p === 'denied' || p === 'default' ? p : 'unsupported';
};

/** Top of HQ Support: how many school requests wait, and a one-tap switch for desktop notices on this browser. */
export function HqSupportAlertBar({ language: lang = 'en' }: { language?: string }): React.ReactElement | null {
  const alerts = useSupportAlerts(lang);
  const [permission, setPermission] = useState<Permission>('unsupported');
  useEffect(() => { setPermission(permissionNow()); }, []);
  const t = (k: Parameters<typeof supportText>[1], v?: Record<string, string>) => supportText(lang, k, v);
  const ask = async () => {
    const N = (globalThis as { Notification?: { requestPermission?: () => Promise<string> } }).Notification;
    try { await N?.requestPermission?.(); } catch { /* the browser decides */ }
    setPermission(permissionNow());
  };
  return <div className={styles.notice} data-hq-support-alerts={alerts?.needsReply ?? 'none'}>
    {alerts && alerts.needsReply > 0 ? <p role="status"><strong>{t('needsReplyBanner', { count: String(alerts.needsReply) })}</strong>{' '}
      {alerts.latest.slice(0, 3).map((a, i) => <React.Fragment key={a.caseId}>{i > 0 ? ' · ' : ''}<a href={`/hq/support/${a.caseId}`}>{`${a.schoolDisplayName}: ${a.subject}`}</a></React.Fragment>)}</p> : null}
    {permission === 'granted' ? <p className={styles.meta}>{t('alertsOn')}</p>
      : permission === 'denied' ? <p className={styles.meta}>{t('alertsBlocked')}</p>
      : permission === 'default' ? <p className={styles.meta}>{t('alertsOff')} <button type="button" className={styles.secondary} onClick={() => { void ask(); }}>{t('alertsTurnOn')}</button></p> : null}
  </div>;
}
