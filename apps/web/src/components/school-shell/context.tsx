'use client';
import React, { createContext, useContext, type ReactNode } from 'react';
import { DEFAULT_HON_INTERFACE_THEME, type HonInterfaceTheme } from '@hon/design-system';
import type { EntryPhase } from '../school-entry/controller';
import type { OperationalSchoolScope } from '../operational-navigation';
import { defaultArtStyle, type HonArtStyle } from '../hon-command/roster';

/**
 * What the shell has verified, for pages that want it: the current school selector and view.
 * Presentation and navigation only: every page API still authorizes the exact school itself.
 */
export type SchoolShellState = Readonly<{
  phase: EntryPhase; selection: OperationalSchoolScope | null; schoolName: string | null; mode: HonInterfaceTheme;
  /** The viewer's AI team art style on this device; presentation only. */
  artStyle: HonArtStyle; onArtStyle: (style: HonArtStyle) => void;
  /** Change this viewer's view for this school (the same save the header switch makes). Resolves true once the server saved it. */
  onMode: (mode: HonInterfaceTheme, via: 'ONBOARDING' | 'SETTINGS') => Promise<boolean>;
}>;

export const NO_SCHOOL_SHELL: SchoolShellState = { phase: 'IDLE', selection: null, schoolName: null, mode: DEFAULT_HON_INTERFACE_THEME,
  artStyle: defaultArtStyle(DEFAULT_HON_INTERFACE_THEME), onArtStyle: () => {}, onMode: async () => false };
const Context = createContext<SchoolShellState>(NO_SCHOOL_SHELL);

export function SchoolShellProvider({ value, children }: { value: SchoolShellState; children?: ReactNode }): React.ReactElement {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useSchoolShell(): SchoolShellState { return useContext(Context); }
