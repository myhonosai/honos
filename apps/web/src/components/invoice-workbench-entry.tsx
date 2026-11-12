'use client';
import React from 'react';
import { useSchoolShell } from './school-shell/context';
import { InvoiceWorkbench } from './invoice-workbench';

/** Staff page entry: the verified shell school supplies the invoice school selectors. */
export function InvoiceWorkbenchEntry(): React.ReactElement {
  const shell = useSchoolShell();
  const shellScope = shell.phase === 'READY' && shell.selection ? { organizationId: shell.selection.organizationId, schoolId: shell.selection.schoolId } : null;
  return <InvoiceWorkbench shellScope={shellScope}/>;
}
