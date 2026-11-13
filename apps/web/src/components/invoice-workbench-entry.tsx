'use client';
import React from 'react';
import { useSchoolShell } from './school-shell/context';
import { InvoiceWorkbench } from './invoice-workbench';
import { InvoiceList } from './invoice-list/invoice-list';

/** Staff page entry: the verified shell school supplies the invoice school selectors and the school's invoice list. */
export function InvoiceWorkbenchEntry(): React.ReactElement {
  const shell = useSchoolShell();
  const shellScope = shell.phase === 'READY' && shell.selection ? { organizationId: shell.selection.organizationId, schoolId: shell.selection.schoolId } : null;
  return <>
    <InvoiceWorkbench shellScope={shellScope}/>
    {shellScope ? <div key={`${shellScope.organizationId}/${shellScope.schoolId}`} data-shell-private=""><InvoiceList scope={shellScope}/></div> : null}
  </>;
}
