import React from 'react';
import { BillingAccountWorkbench } from '../../../../components/billing-account-workbench';

// The shared /staff layout verifies the signed session. Every lookup and
// command independently reauthorizes the direct current human and school.
export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Human Billing Account Workbench', robots: { index: false, follow: false } };

export default function StaffBillingAccountsPage() {
  return <BillingAccountWorkbench />;
}
