import React from 'react';
import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, sessionConfig, verifySession } from '@hon/auth';
import { parseAccountSelectors } from '../../../components/account-status/selectors';
import { SchoolAccountStatus } from '../../../components/account-status/workbench';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | School Account & Usage', referrer: 'no-referrer', robots: { index: false, follow: false } };
export default async function Page({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }): Promise<React.ReactElement> {
  const token = (await cookies()).get(HON_SESSION_COOKIE)?.value ?? ''; let subject: string;
  try { subject = verifySession(token, sessionConfig()).externalSubject; } catch { redirect('/auth/login'); }
  // Session continuity only; known selectors never initiate a domain read.
  return <SchoolAccountStatus key={createHash('sha256').update(token).digest('hex')} sessionSubject={subject} {...parseAccountSelectors(await searchParams)}/>;
}
