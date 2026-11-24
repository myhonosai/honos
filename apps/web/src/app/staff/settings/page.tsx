import React from 'react';
import { requireVerifiedWebSession } from '../../../server/require-web-session';
import { SchoolSettingsSummary } from '../../../components/school-settings/summary';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Settings', description: 'Everything set up for your school, with a link to change each.', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** Settings summary. Fails closed without a verified session; every card re-authorizes through its own existing read. */
export default async function SchoolSettingsPage(): Promise<React.ReactElement> {
  await requireVerifiedWebSession();
  return <SchoolSettingsSummary />;
}
