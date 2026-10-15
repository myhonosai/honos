import pg from 'pg';

const { Client } = pg;
const subject = process.env.HON_HQ_OWNER_EXTERNAL_SUBJECT;
const email = process.env.HON_HQ_OWNER_EMAIL;
const displayName = process.env.HON_HQ_OWNER_DISPLAY_NAME;
const databaseUrl = process.env.DATABASE_URL;

if (!subject) throw new Error('HON_HQ_OWNER_EXTERNAL_SUBJECT must be supplied from a verified HON session.');
if (!email || !displayName) throw new Error('HON_HQ_OWNER_EMAIL and HON_HQ_OWNER_DISPLAY_NAME must be supplied from the verified OAuth profile.');
if (!databaseUrl) throw new Error('DATABASE_URL must be configured for privileged HON HQ owner bootstrap.');

const client = new Client({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false },
});
await client.connect();

try {
  await client.query('BEGIN');
  const user = await client.query(
    `INSERT INTO hon.users (external_subject, email, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (external_subject)
     DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, updated_at = now()
     RETURNING id`,
    [subject, email.toLowerCase(), displayName],
  );
  const userId = user.rows[0]?.id;
  if (!userId) throw new Error('HON user provisioning did not return an identifier.');
  const principal = await client.query(
    `SELECT id FROM hon.principals
     WHERE user_id = $1::uuid AND principal_type = 'HUMAN_USER' AND is_active = true
     FOR UPDATE`,
    [userId],
  );
  let principalId = principal.rows[0]?.id;
  if (!principalId) {
    const createdPrincipal = await client.query(
      `INSERT INTO hon.principals (principal_type, user_id, display_name)
       VALUES ('HUMAN_USER', $1::uuid, $2) RETURNING id`,
      [userId, displayName],
    );
    principalId = createdPrincipal.rows[0]?.id;
  }
  if (!principalId) throw new Error('HON principal provisioning did not return an identifier.');
  await client.query(
    `INSERT INTO hon.hq_operator_grants (principal_id, hq_role, permission_codes)
     SELECT $1::uuid, 'HON_HQ_OWNER', ARRAY['hq.dashboard.view']::text[]
     WHERE NOT EXISTS (
       SELECT 1 FROM hon.hq_operator_grants
       WHERE principal_id = $1::uuid AND hq_role = 'HON_HQ_OWNER'
         AND effective_from <= now() AND (effective_until IS NULL OR effective_until > now())
     )`,
    [principalId],
  );
  const granted = await client.query(
    `SELECT 1
     FROM hon.hq_operator_grants
     WHERE principal_id = $1::uuid AND hq_role = 'HON_HQ_OWNER'
       AND effective_from <= now() AND (effective_until IS NULL OR effective_until > now())`,
    [principalId],
  );
  if (!granted.rowCount) throw new Error('HON HQ owner grant was not present after bootstrap.');
  await client.query('COMMIT');
  console.log('HON HQ owner grant is active for the verified current session.');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
