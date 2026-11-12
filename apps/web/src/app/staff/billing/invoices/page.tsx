import React from 'react';
import { InvoiceWorkbenchEntry } from '../../../../components/invoice-workbench-entry';
// The shared /staff layout verifies the signed session. Each canonical command
// independently authorizes the current exact school and invoice permission.
export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Human Invoice Workbench', robots: { index: false, follow: false } };
export default function StaffInvoicesPage() {
  return <InvoiceWorkbenchEntry />;
}
