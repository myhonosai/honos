// Disposable-database helper for proofs whose fixtures are built through HQ provisioning and then use school features.
// Since D9 (0185) HQ provisioning holds a new school's entitlement SUSPENDED: no school has free access until it pays or
// an HQ owner grants an exception. These fixtures stand in for a school provisioned before D9 (an existing customer
// whose ACTIVE entitlement 0185 leaves untouched), so the proof activates that one entitlement directly. Never run this
// against anything but the disposable validation database.
export async function activatePreD9ProvisionedSchool(admin, organizationId) {
  const r = await admin.query(`UPDATE hon.organization_entitlements SET status='ACTIVE', updated_at=clock_timestamp()
    WHERE organization_id=$1 AND status='SUSPENDED' AND version=1 AND effective_until IS NULL
      AND NOT EXISTS (SELECT 1 FROM hon.saas_access_states s WHERE s.organization_id=$1)
    RETURNING organization_id`, [organizationId]);
  if (r.rowCount !== 1) throw new Error('Expected a freshly provisioned (SUSPENDED, version 1) fixture entitlement.');
}
