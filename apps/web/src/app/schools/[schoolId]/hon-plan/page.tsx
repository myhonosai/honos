import React from 'react';
import { SchoolSubscription } from '../../../../components/school-subscription/subscription';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON OS | Verify school checkout' };

/** B5's hosted return destination. Path/query values are never used as account or payment authority. */
export default async function SchoolCheckoutReturn(): Promise<React.ReactElement> {
  await requireVerifiedWebSession();
  return <SchoolSubscription returnedFromCheckout/>;
}
