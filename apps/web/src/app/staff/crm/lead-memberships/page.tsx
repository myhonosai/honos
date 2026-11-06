import React from 'react';
import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, verifySession, sessionConfig } from '@hon/auth';
import { CrmLeadMembershipsWorkbench } from '../../../../components/crm-lead-memberships-workbench';
import { leadMembershipScope, type LeadMembershipScope } from '../../../../components/crm-lead-memberships-http';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | CRM Membership Recovery', robots: { index: false, follow: false } };
export default async function LeadMembershipsPage({ searchParams }: { searchParams: Promise<Record<string, unknown>> }) {
  const query = await searchParams, token = (await cookies()).get(HON_SESSION_COOKIE)?.value ?? '';
  let sessionSubject: string;
  try { sessionSubject = verifySession(token, sessionConfig()).externalSubject; } catch { redirect('/auth/login'); }
  let scope: LeadMembershipScope | null = null;
  try { scope = leadMembershipScope(query as LeadMembershipScope); } catch { /* Closed selectors; never establish authority or initiate a read. */ }
  const key = [createHash('sha256').update(token).digest('hex'), scope?.organizationId, scope?.schoolId, scope?.leadId].join(':');
  return <CrmLeadMembershipsWorkbench key={key} sessionSubject={sessionSubject} scope={scope} />;
}
