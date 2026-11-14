'use client';
import React, { useEffect, useRef, type ReactNode } from 'react';
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

/**
 * Renders the manual organization/school ID fields only when the shell has no verified school (for example outside the
 * shell). Pass the page's own school value as `current`: a page that cleared it after an access change (its fields are
 * hidden) then offers a reload, which verifies the school again, instead of a dead end.
 */
export function ManualSchoolFields({ children, current }: { children?: ReactNode; current?: string | undefined }): React.ReactElement | null {
  const school = useShellSchool();
  // Only a page that had the school and then cleared it is stuck; the first paint (before the copy) is not.
  const had = useRef(false);
  if (current) had.current = true;
  if (!school) return <>{children}</>;
  if (current === undefined || current !== '' || !had.current) return null;
  return <p role="status">Your access changed, so this page stopped. <button type="button" onClick={() => window.location.reload()}>Reload page</button></p>;
}
