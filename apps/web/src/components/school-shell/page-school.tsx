'use client';
import React, { useEffect, type ReactNode } from 'react';
import type { OperationalSchoolScope } from '../operational-navigation';
import { useSchoolShell } from './context';

/**
 * The school the shell verified for this session, for pages that used to ask for organization and school IDs.
 * A navigation selector only: every page API still authorizes the exact school on the server. Switching school
 * reloads the page, so within one page this goes from null to one school (or back to null when concealed).
 */
export function useShellSchool(): OperationalSchoolScope | null {
  const shell = useSchoolShell();
  return shell.phase === 'READY' && shell.selection ? shell.selection : null;
}

/** Copies the shell's school into a page's own fields once it is verified, and returns it. */
export function useShellSchoolInto(apply: (school: OperationalSchoolScope) => void): OperationalSchoolScope | null {
  const school = useShellSchool();
  useEffect(() => { if (school) apply(school); }, [school?.organizationId, school?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps
  return school;
}

/** Renders the manual organization/school ID fields only when the shell has no verified school (for example outside the shell). */
export function ManualSchoolFields({ children }: { children?: ReactNode }): React.ReactElement | null {
  return useShellSchool() ? null : <>{children}</>;
}
