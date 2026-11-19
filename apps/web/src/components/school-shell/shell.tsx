'use client';
import '@hon/design-system/src/tokens.css';
import './shell-global.css';
import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { usePathname } from 'next/navigation';
import { DEFAULT_HON_INTERFACE_THEME, type HonInterfaceTheme } from '@hon/design-system';
import { useLocale } from '../localization/provider';
import { LocaleUtility } from '../localization/utility';
import { isSchoolShellPath } from './paths';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { parseOperationalSchoolSelectors } from '../operational-navigation';
import { loadInterfaceThemePreference, saveInterfaceThemePreference } from '../interface-theme-preference';
import { SchoolEntryController, type EntrySnapshot } from '../school-entry/controller';
import { schoolEntryApi } from '../school-entry/http';
import { SCHOOL_SHELL_NAV, schoolShellHref } from './catalog';
import { concealShellPrivateNow, onShellPrivacyEvent } from './privacy';
import { HON_SCREENSAVER_SHOWN_EVENT, ScreensaverController } from './screensaver';
import { SchoolShellFrame, type ShellViewState } from './frame';
import { shellRecolorLegacy } from './legacy-recolor';
import { SCHOOL_TOUR_OPEN_EVENT, markSchoolTourSeen } from './tour';
import { SchoolShellProvider, type SchoolShellState } from './context';
import { defaultArtStyle, isHonArtStyle, type HonArtStyle } from '../hon-command/roster';
import { HON_DEMO_DATA_CHANGED_EVENT, demoDataApi } from '../school-demo-data/http';

/** Per-viewer convenience only (never authority, never shared): the chosen AI team art style. */
export const HON_ART_STYLE_STORAGE_KEY = 'hon.ai-team.art-style';
export function readStoredArtStyle(): HonArtStyle | null {
  try { const value = window.localStorage.getItem(HON_ART_STYLE_STORAGE_KEY); return isHonArtStyle(value) ? value : null; } catch { return null; }
}
function storeArtStyle(style: HonArtStyle): void { try { window.localStorage.setItem(HON_ART_STYLE_STORAGE_KEY, style); } catch { /* device storage unavailable */ } }

/** The URL prefill is a candidate only: just the two closed keys, then server-verified by the controller. */
export function shellPreferredSchool(search: string): { organizationId: string; schoolId: string } | null {
  const params = new URLSearchParams(search);
  const parsed = parseOperationalSchoolSelectors({ organizationId: params.get('organizationId') ?? undefined, schoolId: params.get('schoolId') ?? undefined });
  return parsed.initialOrganizationId && parsed.initialSchoolId ? { organizationId: parsed.initialOrganizationId, schoolId: parsed.initialSchoolId } : null;
}

const paints = (element: Element): boolean => {
  const style = getComputedStyle(element);
  const background = style.backgroundColor, image = style.backgroundImage;
  return !(background === 'transparent' || background === 'rgba(0, 0, 0, 0)') || Boolean(image && image !== 'none');
};
/** A light page surface written for the old light body (no image, near-white colour): recoloured, never kept. */
const paintsLight = (element: Element): boolean => {
  const style = getComputedStyle(element);
  if (style.backgroundImage && style.backgroundImage !== 'none') return false;
  const lightness = shellColorLightness(style.backgroundColor);
  return lightness !== null && lightness >= 0.75;
};
/** Relative lightness 0..1 of a computed `rgb()`/`rgba()` colour; null when it cannot be read. */
export function shellColorLightness(color: string): number | null {
  const match = /^rgba?\(\s*(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/.exec(color.trim());
  if (!match) return null;
  const [r, g, b] = [match[1], match[2], match[3]].map(Number) as [number, number, number];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * A page written for the old light body needs the light canvas; a page with its own surface, or with light text
 * written for the dark theme, must not get it. Decided from the page's main heading (the text people read first)
 * and the surfaces between it and the shell, not only from the page's outer element: an unpainted wrapper can hold
 * either kind of page, and a page can open with a side panel before its heading. The shell's own `main` is never
 * counted (the light canvas paints it).
 */
export function shellNeedsLegacyCanvas(main: Element | null): boolean {
  const first = main?.firstElementChild ?? null;
  if (!main || !first || first.closest('[data-hon-native]') || first.hasAttribute('data-hon-native')) return false;
  const heading = main.querySelector('h1') ?? main.querySelector('h2');
  if (!heading) return !paints(first) || paintsLight(first);
  for (let node: Element | null = heading; node && node !== main; node = node.parentElement) if (paints(node)) return paintsLight(node);
  const lightness = shellColorLightness(getComputedStyle(heading).color);
  return lightness === null || lightness < 0.5;
}

/**
 * School app shell. Holds a navigation selector in mounted memory only; every page
 * and API keeps authorizing the exact school itself. Session invalidation and a school
 * context change conceal the school and drop the prefill. Blur, a hidden tab, page hide
 * or 5 idle minutes only show the screensaver (owner request 2026-11-16): the school and
 * page stay, and lifting it runs a quiet identity + exact-school re-check.
 */
export { SCHOOL_SHELL_BARE_ROUTES } from './paths';

export function SchoolShell({ sessionSubject, children }: { sessionSubject: string; children?: ReactNode }): React.ReactElement {
  const path = usePathname() ?? '/staff';
  if (!isSchoolShellPath(path)) return <>{children}</>;
  return <MountedSchoolShell sessionSubject={sessionSubject}>{children}</MountedSchoolShell>;
}

function MountedSchoolShell({ sessionSubject, children }: { sessionSubject: string; children?: ReactNode }): React.ReactElement {
  const path = usePathname() ?? '/staff';
  const { preferences } = useLocale();
  const controller = useRef<SchoolEntryController | null>(null);
  if (!controller.current) controller.current = new SchoolEntryController(sessionSubject);
  const entry = controller.current;
  const [snapshot, setSnapshot] = useState<EntrySnapshot>(entry.snapshot());
  const [schoolName, setSchoolName] = useState<string | null>(null);
  const [mode, setMode] = useState<HonInterfaceTheme>(DEFAULT_HON_INTERFACE_THEME);
  const [viewState, setViewState] = useState<ShellViewState>('LOCAL');
  const [menuOpen, setMenuOpen] = useState(false);
  const [tourStep, setTourStep] = useState<number | null>(null);
  const [artChoice, setArtChoice] = useState<HonArtStyle | null>(null);
  useEffect(() => { setArtChoice(readStoredArtStyle()); }, []);
  const chooseArtStyle = useCallback((style: HonArtStyle) => { setArtChoice(style); storeArtStyle(style); }, []);
  const themeGeneration = useRef(0);

  useEffect(() => {
    entry.activate();
    const unsubscribe = entry.subscribe(next => { if (next.phase !== 'READY') setSchoolName(current => next.phase === 'LOADING' ? current : null); setSnapshot(next); });
    const conceal = (event: Event) => {
      concealShellPrivateNow();
      setSchoolName(null); entry.conceal(event.type === HON_SESSION_INVALIDATED_EVENT ? 'SESSION' : 'CONCEALED');
    };
    const stop = onShellPrivacyEvent(conceal);
    const preferred = shellPreferredSchool(window.location.search);
    void (preferred ? entry.loadPreferred(preferred) : entry.load());
    return () => { unsubscribe(); entry.dispose(); stop(); };
  }, [entry]);

  // Verified personal view preference for the selected school; presentation only.
  const selection = snapshot.phase === 'READY' ? snapshot.selection : null;
  useEffect(() => {
    if (!selection) return;
    const generation = ++themeGeneration.current;
    loadInterfaceThemePreference(selection).then(
      preference => { if (generation !== themeGeneration.current) return; setMode(preference.interfaceTheme); setViewState(preference.selectedVia === 'DEFAULT' ? 'LOCAL' : 'SAVED'); },
      () => { if (generation === themeGeneration.current) setViewState('LOCAL'); });
  }, [selection?.organizationId, selection?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Name only: the existing closed choices read lists names for multi-school staff. Single-school staff see a generic label.
  useEffect(() => {
    if (!selection || schoolName) return;
    const abort = new AbortController();
    schoolEntryApi.choices(AbortSignal.any([abort.signal, AbortSignal.timeout(8000)])).then(result => {
      if (abort.signal.aborted || result.state !== 'SELECTION_REQUIRED') return;
      const match = result.schools.find(choice => choice.schoolId === selection.schoolId && choice.organizationId === selection.organizationId);
      if (match && entry.snapshot().phase === 'READY' && entry.snapshot().selection?.schoolId === match.schoolId) setSchoolName(match.schoolName);
    }, () => {});
    return () => abort.abort();
  }, [selection?.organizationId, selection?.schoolId, schoolName]); // eslint-disable-line react-hooks/exhaustive-deps

  // Screensaver: rendered synchronously on hide so the app switcher and onlookers see it, not records.
  // 0459: a banner while this school has demo data loaded. Read for the verified school only; any refusal (a staff member
  // without the demo data permission included) shows no banner. A load or remove on the Settings page reads it again.
  const [demoLoaded, setDemoLoaded] = useState(false);
  const [demoCheck, setDemoCheck] = useState(0);
  useEffect(() => { const again = () => setDemoCheck(n => n + 1); window.addEventListener(HON_DEMO_DATA_CHANGED_EVENT, again); return () => window.removeEventListener(HON_DEMO_DATA_CHANGED_EVENT, again); }, []);
  useEffect(() => {
    setDemoLoaded(false);
    if (!selection) return;
    const abort = new AbortController();
    const owned = () => !abort.signal.aborted;
    demoDataApi.read({ organizationId: selection.organizationId, schoolId: selection.schoolId }, AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]), owned)
      .then(view => { if (owned()) setDemoLoaded(view.status === 'LOADED'); }, () => {});
    return () => abort.abort();
  }, [selection?.organizationId, selection?.schoolId, demoCheck]); // eslint-disable-line react-hooks/exhaustive-deps

  const [asleep, setAsleep] = useState(false);
  const saver = useRef<ScreensaverController | null>(null);
  useEffect(() => {
    const controller = new ScreensaverController(show => { if (!show) { setAsleep(false); return; } flushSync(() => setAsleep(true)); window.dispatchEvent(new Event(HON_SCREENSAVER_SHOWN_EVENT)); }, () => void entry.recheck());
    saver.current = controller;
    const visibility = () => { if (document.visibilityState === 'hidden') controller.hidden(); else controller.visible(); };
    const hide = () => controller.hidden();
    const show = (event: PageTransitionEvent) => { if (event.persisted) controller.visible({ restored: true }); };
    const activity = () => controller.activity();
    const activityEvents = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show);
    for (const name of activityEvents) window.addEventListener(name, activity, { passive: true, capture: true });
    controller.start();
    return () => {
      controller.stop(); saver.current = null;
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show);
      for (const name of activityEvents) window.removeEventListener(name, activity, { capture: true });
    };
  }, [entry]);
  const wake = useCallback(() => saver.current?.dismiss(), []);

  useEffect(() => { setMenuOpen(false); }, [path]);
  // Guided tour: opened from Home's invitation, the Menu or Settings (event), or a `?tour=1` link. Seen is per device only.
  const tourOpener = useRef<HTMLElement | null>(null);
  const tourNow = useRef<number | null>(null);
  const tour = useCallback((step: number | null) => {
    if (tourNow.current === null && step !== null) tourOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (tourNow.current !== null && step === null) markSchoolTourSeen();
    tourNow.current = step; setTourStep(step);
  }, []);
  useEffect(() => {
    const open = () => tour(0);
    window.addEventListener(SCHOOL_TOUR_OPEN_EVENT, open);
    const params = new URLSearchParams(window.location.search);
    if (params.get('tour') === '1') {
      params.delete('tour');
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash}`);
      open();
    }
    return () => window.removeEventListener(SCHOOL_TOUR_OPEN_EVENT, open);
  }, [tour]);
  // Where am I: a long tab row scrolls so the current page is in view (no page scroll).
  useEffect(() => {
    for (const selector of ['[data-shell-tabs] [aria-current]', '[data-shell-steps] [aria-current]']) {
      const link = document.querySelector<HTMLElement>(selector), row = link?.closest<HTMLElement>('[data-shell-tabs], [data-shell-steps]');
      if (link && row) row.scrollLeft = Math.max(0, link.offsetLeft - (row.clientWidth - link.offsetWidth) / 2);
    }
  }, [path]);
  // Focus returns to whatever opened the menu once it closes (recorded before the panel takes focus).
  const menuOpener = useRef<HTMLElement | null>(null);
  const openMenu = useCallback((open: boolean) => {
    if (open) menuOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMenuOpen(open);
  }, []);

  // Transitional: pages not yet migrated to the UI system were written for the old light page background. Those (and
  // only those) are recoloured onto the dark tokens (consistent look C1) instead of sitting on a light card.
  useEffect(() => {
    const main = document.getElementById('hon-main');
    if (!main) return;
    // Decide from the page as written: start each page with the recolouring off, and once the page's heading is in,
    // keep the decision for this page (the recoloured heading would otherwise read as a native page and flip back).
    main.removeAttribute('data-canvas');
    let decided: boolean | null = null;
    const classify = () => {
      const legacy = decided ?? shellNeedsLegacyCanvas(main);
      if (main.querySelector('h1, h2')) decided = legacy;
      if (legacy) shellRecolorLegacy(main);
      main.setAttribute('data-canvas', legacy ? 'legacy-light' : 'native');
    };
    classify();
    // Pages render their heading after their own reads; re-check (once per frame) as the page fills in.
    let frame = 0;
    const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; classify(); }); });
    observer.observe(main, { childList: true, subtree: true });
    return () => { observer.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [path]);
  const dialogOpen = menuOpen || tourStep !== null;
  useEffect(() => {
    if (!dialogOpen) return;
    const opener = tourStep !== null ? tourOpener.current : menuOpener.current;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMenuOpen(false); tour(null); return; }
      if (event.key !== 'Tab') return;
      // Keyboard focus wraps inside the modal Menu panel (the page behind it is inert).
      const dialog = document.querySelector<HTMLElement>('[data-hon-ui="school"] [role="dialog"][aria-modal="true"]');
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const inside = dialog.contains(document.activeElement);
      if (event.shiftKey && (!inside || document.activeElement === first)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (!inside || document.activeElement === last)) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('keydown', escape); if (opener?.isConnected) opener.focus(); };
  }, [dialogOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveMode = useCallback((next: HonInterfaceTheme, via: 'ONBOARDING' | 'SETTINGS'): Promise<boolean> => {
    setMode(next);
    const scope = entry.snapshot().phase === 'READY' ? entry.snapshot().selection : null;
    if (!scope) { setViewState('LOCAL'); return Promise.resolve(false); }
    const generation = ++themeGeneration.current;
    setViewState('SAVING');
    return saveInterfaceThemePreference(scope, next, crypto.randomUUID(), via).then(
      () => { if (generation === themeGeneration.current) setViewState('SAVED'); return true; },
      () => { if (generation === themeGeneration.current) setViewState('ERROR'); return false; });
  }, [entry]);
  const chooseMode = useCallback((next: HonInterfaceTheme) => { void saveMode(next, 'SETTINGS'); }, [saveMode]);

  const choose = useCallback((schoolId: string) => {
    const current = entry.snapshot();
    const choice = current.choices.find(candidate => candidate.schoolId === schoolId);
    if (!choice) return;
    void entry.choose(schoolId, current.revision).then(() => {
      const after = entry.snapshot();
      if (after.phase !== 'READY' || after.selection?.schoolId !== choice.schoolId) return;
      setSchoolName(choice.schoolName);
      // A new school starts every page fresh: pages drop old-school memory on a full load.
      window.dispatchEvent(new Event(HON_SCHOOL_CONTEXT_CHANGED_EVENT));
      window.location.assign(schoolShellHref(SCHOOL_SHELL_NAV[0]!.routes[0]!, after.selection));
    });
  }, [entry]);

  const shared = useMemo<SchoolShellState>(() => ({ phase: snapshot.phase, selection: snapshot.phase === 'READY' ? snapshot.selection : null,
    schoolName: snapshot.phase === 'READY' ? schoolName : null, mode, artStyle: artChoice ?? defaultArtStyle(mode), onArtStyle: chooseArtStyle, onMode: saveMode }),
  [snapshot, schoolName, mode, artChoice, chooseArtStyle, saveMode]);

  return <SchoolShellFrame path={path} language={preferences.language} phase={snapshot.phase} selection={snapshot.selection} schoolName={schoolName}
    choices={snapshot.choices} mode={mode} viewState={viewState} menuOpen={menuOpen} utility={<LocaleUtility inShell />}
    tourStep={tourStep} onTour={tour} asleep={asleep} onWake={wake} demoLoaded={demoLoaded} onMode={chooseMode} onMenu={openMenu} onSwitch={() => void entry.load()} onChoose={choose} onRestore={() => void entry.load()}>
    <SchoolShellProvider value={shared}>{children}</SchoolShellProvider>
  </SchoolShellFrame>;
}
