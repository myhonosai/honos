'use client';
import React from 'react';
import { useSchoolShell } from './school-shell/context';
import { ChadFollowUpAssistantWorkbench } from './chad-follow-up-assistant-workbench';

/** Staff page entry: the verified shell school supplies the scope of the lead picker. */
export function ChadFollowUpAssistantEntry(): React.ReactElement {
  const shell = useSchoolShell();
  const shellScope = shell.phase === 'READY' && shell.selection ? { organizationId: shell.selection.organizationId, schoolId: shell.selection.schoolId } : null;
  return <ChadFollowUpAssistantWorkbench shellScope={shellScope}/>;
}
