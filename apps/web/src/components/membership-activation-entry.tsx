'use client';
import React from 'react';
import { useSchoolShell } from './school-shell/context';
import { MembershipActivationWorkbench } from './membership-activation-workbench';

/** Staff page entry: the verified shell school supplies the activation selectors. */
export function MembershipActivationEntry(props: Omit<React.ComponentProps<typeof MembershipActivationWorkbench>, 'shellScope'>): React.ReactElement {
  const shell = useSchoolShell();
  const shellScope = shell.phase === 'READY' && shell.selection ? { organizationId: shell.selection.organizationId, schoolId: shell.selection.schoolId } : null;
  return <MembershipActivationWorkbench {...props} shellScope={shellScope}/>;
}
