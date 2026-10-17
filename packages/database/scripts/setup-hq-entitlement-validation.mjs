import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, realpath, lstat, writeFile, readFile } from 'node:fs/promises';
import pg from 'pg';
const dir = process.env.HON_HQ_ENTITLEMENT_VALIDATION_DIR;
if (!dir || !/^\/home\/ubuntu\/jobs\/job_[A-Za-z0-9]+\/hq-entitlement-validation$/.test(dir)
  || process.env.HON_HQ_ENTITLEMENT_VALIDATION_TARGET !== 'postgresql://localhost:55432/hon_entitlement_validation') throw new Error('Explicit private job directory and disposable localhost:55432 target required.');
const parent = dir.slice(0,dir.lastIndexOf('/'));
if (await realpath(parent) !== parent || (await lstat(parent)).uid !== process.getuid()) throw new Error('Unsafe job directory.');
// Fresh-only cluster: never reset or attach any existing database or service.
await mkdir(dir,{ mode: 0o700 });
const env = { PATH: process.env.PATH, HOME: '/home/ubuntu', LANG: 'C.UTF-8' };
const ownerPassword = randomBytes(36).toString('base64url');
const runtimePassword = randomBytes(36).toString('base64url');
await writeFile(`${dir}/owner-password`,ownerPassword+'\n',{ flag:'wx',mode:0o600 });
function run(command,args) {
  const result = spawnSync(command,args,{ env,encoding:'utf8' });
  if (result.status !== 0) throw new Error(`Disposable setup failed: ${result.stderr.replaceAll(ownerPassword,'[REDACTED]').replaceAll(runtimePassword,'[REDACTED]')}`);
}
run('/usr/lib/postgresql/16/bin/initdb',['-D',`${dir}/data`,'-U','postgres','--auth-local=trust','--auth-host=scram-sha-256',`--pwfile=${dir}/owner-password`]);
await mkdir(`${dir}/socket`,{mode:0o700});
run('/usr/lib/postgresql/16/bin/pg_ctl',['-D',`${dir}/data`,'-l',`${dir}/postgres.log`,'-o',`-h 127.0.0.1 -p 55432 -k ${dir}/socket`,'-w','start']);
const ownerUrl = `postgresql://postgres:${ownerPassword}@localhost:55432/hon_entitlement_validation`;
const runtimeUrl = `postgresql://hon_runtime:${runtimePassword}@localhost:55432/hon_entitlement_validation`;
const admin = new pg.Client({connectionString:ownerUrl.replace('/hon_entitlement_validation','/postgres'),ssl:false});
await admin.connect();
try {
  await admin.query('CREATE DATABASE hon_entitlement_validation');
  await admin.query("COMMENT ON DATABASE hon_entitlement_validation IS 'HON disposable entitlement boundary validation'");
  await admin.query('REVOKE ALL ON DATABASE hon_entitlement_validation FROM PUBLIC');
  await admin.query(`CREATE ROLE hon_runtime LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`);
  await admin.query('GRANT CONNECT ON DATABASE hon_entitlement_validation TO hon_runtime');
} finally { await admin.end(); }
const migrated = spawnSync(process.execPath,[new URL('./migrate.mjs',import.meta.url).pathname],{env:{...env,DATABASE_URL:ownerUrl},encoding:'utf8'});
if (migrated.status !== 0) throw new Error(`Disposable migrations failed: ${migrated.stderr.replaceAll(ownerPassword,'[REDACTED]')}`);
console.log(migrated.stdout.trim());
const owner = new pg.Client({connectionString:ownerUrl,ssl:false});
await owner.connect();
try {
  const canonical = await readFile(new URL('../../../infra/postgres/010_supabase_hon_runtime.sql',import.meta.url),'utf8');
  await owner.query(canonical); await owner.query(canonical);
} finally { await owner.end(); }
await writeFile(`${dir}/validation.env`,`export DATABASE_URL='${ownerUrl}'\nexport HON_RUNTIME_DATABASE_URL='${runtimeUrl}'\n`,{flag:'wx',mode:0o600});
console.log('PASS: fresh private disposable localhost:55432 cluster; migrations + canonical ACL applied twice; generated credentials only in mode-0600 job file. Stop with pg_ctl -D <validation directory>/data -m fast -w stop.');
