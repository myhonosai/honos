'use client';
import React from 'react';
import { useSchoolShell } from './school-shell/context';
import { ClassPassWorkbench } from './classpass-workbench';
import { KioskWorkbench } from './kiosk-workbench';

/** The signed-in school from the staff shell, or null while none is chosen. The API authorizes the school again. */
function useShellScope(): { organizationId: string; schoolId: string } | null {
  const shell = useSchoolShell();
  return shell.phase === 'READY' && shell.selection ? { organizationId: shell.selection.organizationId, schoolId: shell.selection.schoolId } : null;
}
/** Older ClassPass tool, opened on the signed-in school: no school ID fields. */
export function ClassPassWorkbenchEntry(): React.ReactElement {
  const scope = useShellScope();
  return <ClassPassWorkbench key={scope ? `${scope.organizationId}/${scope.schoolId}` : 'none'} shellScope={scope}/>;
}
/** Older check-in kiosk tool, opened on the signed-in school: no school ID fields. */
export function KioskWorkbenchEntry(): React.ReactElement {
  const scope = useShellScope();
  return <KioskWorkbench key={scope ? `${scope.organizationId}/${scope.schoolId}` : 'none'} shellScope={scope}/>;
}
