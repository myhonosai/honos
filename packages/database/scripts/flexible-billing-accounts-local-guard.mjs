import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

const descriptorKey = 'HON_FLEXIBLE_BILLING_ACCOUNTS_ENV_FILE';
const setupSelectors = new Set(['HON_FLEXIBLE_BILLING_ACCOUNTS_VALIDATION_TARGET', descriptorKey]);
const database = 'hon_flexible_billing_accounts_validation';
const owner = 'hon_flexible_billing_accounts_owner';
const runtime = 'hon_flexible_billing_accounts_runtime';
const externalPrefix = /^(?:OPENROUTER|DIRECT_LLM_API|HEYGEN|HIGGSFIELD|OPENAI|ANTHROPIC|GOOGLE|STRIPE|SQUARE|TWILIO|SHOPIFY|META|FACEBOOK|INSTAGRAM|TIKTOK|SENDGRID|MAILGUN|POSTMARK|SLACK|DISCORD|AWS|AZURE|GCP|GOOGLE_CLOUD|SUPABASE)(?:_|$)/i;
const credentialName = /(?:^|_)(?:API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|PRIVATE_KEY)(?:_|$)/i;
const executionPrefix = /^(?:HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER)|(?:PROVIDER|EXECUTION|WORKER|CONSUMER|DELIVERY|PAYMENT|MESSAGING|COMMUNICATION|ACTION_ENGINE))(?:_|$)/i;

export const flexibleBillingAccountsFixture = Object.freeze({ database, owner, runtime, descriptorKey });

export function refuseFlexibleBillingAccountsExternalEnvironment() {
  if (['NODE_ENV', 'HON_ENV', 'HON_ENVIRONMENT', 'APP_ENV', 'ENVIRONMENT'].some((key) => /^(?:prod(?:uction)?|live)$/i.test(process.env[key] ?? ''))) {
    throw new Error('Flexible billing-account validation refuses production/live environments.');
  }
  if (Object.keys(process.env).some((key) => /^PG(?:HOST|PORT|USER|PASSWORD|DATABASE|SERVICE|SSLMODE|OPTIONS|PASSFILE)/i.test(key))) {
    throw new Error('Flexible billing-account validation refuses inherited PostgreSQL overrides.');
  }
  const risky = Object.keys(process.env).filter((key) => !setupSelectors.has(key)
    && (externalPrefix.test(key) || credentialName.test(key) || executionPrefix.test(key)));
  if (risky.length) {
    throw new Error(`Flexible billing-account local validation refuses provider/payment/messaging credentials or execution switches (${risky.join(', ')}).`);
  }
}

function expectedUrl(key) {
  const username = key === 'DATABASE_URL' ? owner : runtime;
  const value = process.env[key] ?? '';
  let url;
  try { url = new URL(value); } catch { throw new Error('Flexible billing-account validation requires exact guarded disposable localhost aliases.'); }
  if (url.protocol !== 'postgresql:' || url.hostname !== 'localhost' || url.port !== '5432'
    || url.pathname !== `/${database}` || url.search || url.hash || !url.password || url.username !== username) {
    throw new Error('Flexible billing-account validation requires exact guarded disposable localhost aliases.');
  }
  return value;
}

async function requirePrivateDescriptor(urls) {
  const descriptor = process.env[descriptorKey];
  if (!descriptor || !descriptor.startsWith('/home/ubuntu/jobs/')) throw new Error('Flexible billing-account validation requires a guarded private job descriptor.');
  const normalized = resolve(descriptor);
  if (normalized !== descriptor || basename(normalized) !== basename(descriptor)) throw new Error('Flexible billing-account descriptor path is unsafe.');
  const jobsRoot = await realpath('/home/ubuntu/jobs');
  let directory;
  try { directory = await realpath(dirname(normalized)); } catch { throw new Error('Flexible billing-account descriptor parent is unsafe.'); }
  if (!directory.startsWith(`${jobsRoot}/`) || `${directory}/${basename(normalized)}` !== normalized) throw new Error('Flexible billing-account descriptor path is unsafe.');
  const directoryStat = await lstat(directory);
  const descriptorStat = await lstat(normalized);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.uid !== process.getuid() || (directoryStat.mode & 0o777) !== 0o700
    || !descriptorStat.isFile() || descriptorStat.isSymbolicLink() || descriptorStat.uid !== process.getuid() || (descriptorStat.mode & 0o777) !== 0o600
    || descriptorStat.size > 4096) {
    throw new Error('Flexible billing-account descriptor is not private and regular.');
  }
  const expected = [
    `export DATABASE_URL='${urls.DATABASE_URL}'`,
    `export HON_RUNTIME_DATABASE_URL='${urls.HON_RUNTIME_DATABASE_URL}'`,
    `export ${descriptorKey}='${normalized}'`,
    '',
  ].join('\n');
  if ((await readFile(normalized, 'utf8')) !== expected) throw new Error('Flexible billing-account descriptor content is unsafe.');
}

export async function requireFlexibleBillingAccountsLocalUrls({ requireDescriptor = true } = {}) {
  refuseFlexibleBillingAccountsExternalEnvironment();
  const urls = {
    DATABASE_URL: expectedUrl('DATABASE_URL'),
    HON_RUNTIME_DATABASE_URL: expectedUrl('HON_RUNTIME_DATABASE_URL'),
  };
  if (requireDescriptor) await requirePrivateDescriptor(urls);
  return urls;
}
