'use client';
import '@hon/design-system/src/tokens.css';
import './shell-global.css';
import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { SchoolShellFrame, type ShellViewState } from './frame';
import { SchoolShellProvider, type SchoolShellState } from './context';
import { defaultArtStyle, isHonArtStyle, type HonArtStyle } from '../hon-command/roster';

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

/** A page root with no own background (and no UI-system marker) was designed for the old light body. */
export function shellNeedsLegacyCanvas(root: Element | null): boolean {
  if (!root || root.closest('[data-hon-native]') || root.hasAttribute('data-hon-native')) return false;
  const background = getComputedStyle(root).backgroundColor;
  const image = getComputedStyle(root).backgroundImage;
  return (background === 'transparent' || background === 'rgba(0, 0, 0, 0)') && (!image || image === 'none');
}

/**
 * School app shell. Holds a navigation selector in mounted memory only; every page
 * and API keeps authorizing the exact school itself. Session invalidation, a school
 * context change, blur, a hidden tab or page hide conceal the school and drop the prefill;
 * only an explicit re-verification of the current identity and exact school restores it.
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
    const stop = onShellPrivacyEvent(conceal, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]);
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

  useEffect(() => { setMenuOpen(false); }, [path]);
  // Focus returns to whatever opened the menu once it closes (recorded before the panel takes focus).
  const menuOpener = useRef<HTMLElement | null>(null);
  const openMenu = useCallback((open: boolean) => {
    if (open) menuOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMenuOpen(open);
  }, []);

  // Transitional: pages not yet migrated to the UI system may rely on the old light page
  // background. Give those (and only those) a light canvas so their text stays readable.
  useEffect(() => {
    const main = document.getElementById('hon-main');
    if (!main) return;
    const classify = () => main.setAttribute('data-canvas', shellNeedsLegacyCanvas(main.firstElementChild) ? 'legacy-light' : 'native');
    classify();
    const observer = new MutationObserver(classify);
    observer.observe(main, { childList: true });
    return () => observer.disconnect();
  }, [path]);
  useEffect(() => {
    if (!menuOpen) return;
    const opener = menuOpener.current;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMenuOpen(false); return; }
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
  }, [menuOpen]);

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
    onMode={chooseMode} onMenu={openMenu} onSwitch={() => void entry.load()} onChoose={choose} onRestore={() => void entry.load()}>
    <SchoolShellProvider value={shared}>{children}</SchoolShellProvider>
  </SchoolShellFrame>;
}
