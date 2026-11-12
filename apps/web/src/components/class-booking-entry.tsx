'use client';
import React from 'react';
import { useSchoolShell } from './school-shell/context';
import { ClassBookingWorkbench } from './class-booking-workbench';

/** Staff page entry: the verified shell school supplies the booking school selectors. */
export function ClassBookingEntry({ initialPrefill }: { initialPrefill?: unknown }): React.ReactElement {
  const shell = useSchoolShell();
  const shellScope = shell.phase === 'READY' && shell.selection ? { organizationId: shell.selection.organizationId, schoolId: shell.selection.schoolId } : null;
  return <ClassBookingWorkbench initialPrefill={initialPrefill} shellScope={shellScope}/>;
}
