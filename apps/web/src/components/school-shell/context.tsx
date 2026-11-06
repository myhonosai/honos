'use client';
import React, { createContext, useContext, type ReactNode } from 'react';
import { DEFAULT_HON_INTERFACE_THEME, type HonInterfaceTheme } from '@hon/design-system';
import type { EntryPhase } from '../school-entry/controller';
import type { OperationalSchoolScope } from '../operational-navigation';

/**
 * What the shell has verified, for pages that want it: the current school selector and view.
 * Presentation and navigation only: every page API still authorizes the exact school itself.
 */
export type SchoolShellState = Readonly<{ phase: EntryPhase; selection: OperationalSchoolScope | null; schoolName: string | null; mode: HonInterfaceTheme }>;

export const NO_SCHOOL_SHELL: SchoolShellState = { phase: 'IDLE', selection: null, schoolName: null, mode: DEFAULT_HON_INTERFACE_THEME };
const Context = createContext<SchoolShellState>(NO_SCHOOL_SHELL);

export function SchoolShellProvider({ value, children }: { value: SchoolShellState; children?: ReactNode }): React.ReactElement {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useSchoolShell(): SchoolShellState { return useContext(Context); }
