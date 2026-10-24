import React from 'react';
import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, verifySession, sessionConfig } from '@hon/auth';
import { CrmLeadsWorkbench } from '../../../../components/crm-leads-workbench';

export const dynamic = 'force-dynamic';

type CrmLeadsPageProps = { searchParams: Promise<{ organizationId?: string; schoolId?: string }> };

function value(input: unknown): string | undefined {
  return typeof input === 'string' && input.length <= 80 ? input : undefined;
}

export default async function CrmLeadsPage({ searchParams }: CrmLeadsPageProps) {
  const query = await searchParams;
  // The shared staff layout verifies this signed session. This opaque React key
  // only remounts memory state after session changes; it is never API authority.
  const token = (await cookies()).get(HON_SESSION_COOKIE)?.value ?? '';
  const sessionViewKey = createHash('sha256').update(token).digest('hex');
  let sessionSubject: string;
  try {
    sessionSubject = verifySession(token, sessionConfig()).externalSubject;
  } catch {
    // The session may expire after the layout gate. Never render a stale CRM view.
    redirect('/auth/login');
  }
  return <CrmLeadsWorkbench key={sessionViewKey} sessionSubject={sessionSubject} initialScope={{ organizationId: value(query.organizationId), schoolId: value(query.schoolId) }} />;
}
