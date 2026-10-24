import React from 'react';
import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { HON_SESSION_COOKIE } from '@hon/auth';
import { SchoolMembershipCatalog } from '../../../../components/membership-plans/catalog';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'School membership plans | HON OS', robots: { index: false, follow: false } };
export default async function SchoolMembershipPlansPage(): Promise<React.ReactElement> {
  const token = (await cookies()).get(HON_SESSION_COOKIE)?.value ?? '';
  return <SchoolMembershipCatalog key={createHash('sha256').update(token).digest('hex')} />;
}
