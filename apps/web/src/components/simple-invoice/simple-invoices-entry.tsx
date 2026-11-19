'use client';
import React from 'react';
import { useSchoolShell } from '../school-shell/context';
import { SimpleInvoices } from './simple-invoices';

/** Staff page entry: the verified shell school is the only school this page works with; another school starts clean. */
export function SimpleInvoicesEntry(): React.ReactElement {
  const shell = useSchoolShell();
  const scope = shell.phase === 'READY' && shell.selection ? { organizationId: shell.selection.organizationId, schoolId: shell.selection.schoolId } : null;
  if (!scope) return <p role="status">Choose a school to see its invoices.</p>;
  return <div key={`${scope.organizationId}/${scope.schoolId}`} data-shell-private=""><SimpleInvoices scope={scope} schoolName={shell.schoolName}/></div>;
}
