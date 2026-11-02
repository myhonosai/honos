import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Synthetic approval ONLY in the exact disposable proof database. Never a migration/seed or runtime helper. */
export async function syntheticExceptionPolicy(admin, service, subject, patch = {}) {
  const identity = (await admin.query("SELECT current_database() db,current_user usr,inet_server_port() port,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
  assert.deepEqual(identity, { db: 'hon_champions_validation', usr: 'hon_champions_owner', port: 5432, marker: 'HON disposable Champions Club validation' });
  const view = await service.readExceptionPolicy(subject);
  // Bind to the latest proposed paid-access terms version (a newer version supersedes older approvals).
  const termsVersion = Number((await admin.query('SELECT max(policy_version) v FROM hon.saas_access_policy_terms')).rows[0].v);
  return service.decideExceptionPolicy(subject, {
    expectedRevision: view.current?.revision ?? 0, decision: 'APPROVED', termsVersion, maxDays: 90,
    validFrom: new Date(Date.now() - 60_000).toISOString(), validUntil: new Date(Date.now() + 86400_000).toISOString(),
    reason: 'DISPOSABLE SYNTHETIC TEST ONLY; no operational policy approval',
    confirmation: 'APPROVE_ACCESS_EXCEPTION_POLICY_ONLY', ...patch,
  }, randomUUID());
}
