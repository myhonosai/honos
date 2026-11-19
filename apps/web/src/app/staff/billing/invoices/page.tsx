import React from 'react';
import { SimpleInvoicesEntry } from '../../../../components/simple-invoice/simple-invoices-entry';
// The shared /staff layout verifies the signed session. Each command independently authorizes the current school and
// invoice permission on the server (SI1, 0558).
export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Invoices', robots: { index: false, follow: false } };
export default function StaffInvoicesPage() {
  return <SimpleInvoicesEntry />;
}
