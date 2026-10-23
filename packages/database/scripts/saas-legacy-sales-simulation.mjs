// HON OS-only new sales (0184, D8): legacy Core/Complete new sales are pinned CLOSED by a CHECK. The legacy proofs
// (B1-B6A, 0181, 0182) still exercise legacy sales and their continuation, so they reopen legacy sales ONLY in their
// disposable database and close them again (CHECK restored) before they finish. Never run against a real database.
const CHECK = "CHECK ((legacy_new_sales = 'CLOSED'::text))";

export async function setLegacySales(admin, open) {
  await admin.query('BEGIN');
  try {
    await admin.query('ALTER TABLE hon.saas_new_sales_policy DISABLE TRIGGER USER');
    if (open) {
      await admin.query('ALTER TABLE hon.saas_new_sales_policy DROP CONSTRAINT IF EXISTS saas_new_sales_policy_legacy_check');
      await admin.query("UPDATE hon.saas_new_sales_policy SET legacy_new_sales='OPEN'");
    } else {
      await admin.query("UPDATE hon.saas_new_sales_policy SET legacy_new_sales='CLOSED'");
      if (!(await admin.query("SELECT 1 FROM pg_constraint WHERE conname='saas_new_sales_policy_legacy_check' AND conrelid='hon.saas_new_sales_policy'::regclass")).rowCount)
        await admin.query("ALTER TABLE hon.saas_new_sales_policy ADD CONSTRAINT saas_new_sales_policy_legacy_check CHECK (legacy_new_sales = 'CLOSED')");
    }
    await admin.query('ALTER TABLE hon.saas_new_sales_policy ENABLE TRIGGER USER');
    await admin.query('COMMIT');
  } catch (error) { await admin.query('ROLLBACK'); throw error; }
}

/** The pinned production posture: legacy new sales CLOSED by the 0184 CHECK, the guard enabled. */
export async function assertLegacySalesClosed(admin) {
  const row = (await admin.query(`SELECT p.legacy_new_sales, p.new_sale_product,
      (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='saas_new_sales_policy_legacy_check' AND conrelid='hon.saas_new_sales_policy'::regclass) AS check_def,
      (SELECT count(*)::int FROM pg_trigger WHERE tgname='saas_legacy_new_sale' AND tgenabled='O') AS guards
    FROM hon.saas_new_sales_policy p`)).rows;
  if (row.length !== 1 || row[0].legacy_new_sales !== 'CLOSED' || row[0].new_sale_product !== 'HON_OS' || row[0].check_def !== CHECK || row[0].guards !== 3)
    throw new Error(`Legacy new sales are not pinned CLOSED: ${JSON.stringify(row)}`);
}
