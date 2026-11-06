import React from 'react';
import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, sessionConfig, verifySession } from '@hon/auth';
import { StaffInvitations } from '../../../../components/staff-invitations/workbench';
import { parseOperationalSchoolSelectors } from '../../../../components/operational-navigation';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON OS | Staff invitations', referrer: 'no-referrer', robots: { index: false, follow: false } };
export default async function Page({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }): Promise<React.ReactElement> {
  const token = (await cookies()).get(HON_SESSION_COOKIE)?.value ?? ''; let subject: string;
  try { subject = verifySession(token, sessionConfig()).externalSubject; } catch { redirect('/auth/login'); }
  // Query values only seed editable selectors. Identity and school authority are
  // rechecked by the workbench after a deliberate human verification.
  return <StaffInvitations key={createHash('sha256').update(token).digest('hex')} sessionSubject={subject} {...parseOperationalSchoolSelectors(await searchParams)}/>;
}
