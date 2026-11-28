import React from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createHash } from 'node:crypto';
import { HON_SESSION_COOKIE, sessionConfig, verifySession } from '@hon/auth';
import { FamilyAccessWorkspace } from '../../../components/family-access/workbench';
import { FamilyInviteActivate } from '../../../components/family-invite/activate';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON OS | Family invitation', referrer: 'no-referrer', robots: { index: false, follow: false } };
export default async function Page(): Promise<React.ReactElement> {
  const token = (await cookies()).get(HON_SESSION_COOKIE)?.value ?? ''; let subject: string, email: string | null;
  try { const proof = verifySession(token, sessionConfig()); subject = proof.externalSubject; email = proof.email ?? null; } catch { redirect('/auth/login?for=family-invitation'); }
  const key = createHash('sha256').update(token).digest('hex');
  // 0714: an invitation opened from the email's button is finished with one press; with none kept, the ID and code page shows.
  return <FamilyInviteActivate key={key} sessionEmail={email} fallback={<FamilyAccessWorkspace key={key} sessionSubject={subject} acceptance />} />;
}
