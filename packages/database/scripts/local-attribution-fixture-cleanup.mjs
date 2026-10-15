/** Test-only cleanup inside the caller's transaction. Never used by application code. */
export async function cleanupLocalAttributionFixtures(client, organizations) {
 const exists=(await client.query("SELECT to_regclass('hon.crm_lead_attributions') present")).rows[0].present;
 if(!exists)return;
 const n=(await client.query('SELECT count(*) n FROM hon.crm_lead_attributions WHERE organization_id=ANY($1::uuid[])',[organizations])).rows[0].n;
 if(n==='0')return;
 const guard=(await client.query("SELECT current_database()='hon_campaign_validation' AND current_user='hon_campaign_owner' AND inet_server_addr() IN('127.0.0.1'::inet,'::1'::inet) safe")).rows[0].safe;
 if(!guard)throw new Error('Attribution fixture deletion is restricted to the disposable local campaign owner/database. Use transaction rollback elsewhere.');
 // Only the two append-only cleanup guards are suspended, only in this owner's
 // transaction. FK/check/coherence constraints and forced RLS stay intact.
 // Rollback restores triggers if any statement fails. No production relaxation.
 await client.query('ALTER TABLE hon.crm_lead_attributions DISABLE TRIGGER lead_attributions_immutable; ALTER TABLE hon.crm_lead_attributions DISABLE TRIGGER lead_attributions_no_truncate');
 await client.query('DELETE FROM hon.crm_lead_attributions WHERE organization_id=ANY($1::uuid[])',[organizations]);
 await client.query('SET CONSTRAINTS ALL IMMEDIATE');
 await client.query('ALTER TABLE hon.crm_lead_attributions ENABLE TRIGGER lead_attributions_immutable; ALTER TABLE hon.crm_lead_attributions ENABLE TRIGGER lead_attributions_no_truncate');
}
