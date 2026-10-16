const setupSelectors = new Set(['HON_HQ_SCHOOLS_VALIDATION_TARGET', 'HON_HQ_SCHOOLS_ENV_FILE']);
const externalPrefix = /^(?:OPENROUTER|DIRECT_LLM_API|HEYGEN|HIGGSFIELD|OPENAI|ANTHROPIC|GOOGLE|STRIPE|SQUARE|TWILIO|SHOPIFY|META|FACEBOOK|INSTAGRAM|TIKTOK|SENDGRID|MAILGUN|POSTMARK|SLACK|DISCORD|AWS|AZURE|GCP|GOOGLE_CLOUD|SUPABASE)(?:_|$)/i;
const executionPrefix = /^(?:HON_)?(?:AI|ACTION(?:_ENGINE)?|PROVIDER(?:S)?|EXTERNAL|PAYMENT(?:S)?|COMMUNICATION(?:S)?|MESSAGING|MESSAGE(?:S)?|DELIVERY|PUBLISH|CONSUMER|WORKER|EXECUTION)(?:_|$)/i;

export function refuseHqSchoolsExternalEnvironment() {
  if (['NODE_ENV', 'HON_ENV', 'HON_ENVIRONMENT', 'APP_ENV', 'ENVIRONMENT'].some((key) => /^(?:prod(?:uction)?|live)$/i.test(process.env[key] ?? ''))) {
    throw new Error('HQ school-directory validation refuses production/live environments.');
  }
  const risky = Object.keys(process.env).filter((key) => !setupSelectors.has(key) && (externalPrefix.test(key) || executionPrefix.test(key)));
  if (risky.length) throw new Error(`HQ school-directory local validation refuses provider, execution, payment, messaging, or live credentials/switches (${risky.join(', ')}).`);
}

export function requireHqSchoolsLocalUrls() {
  refuseHqSchoolsExternalEnvironment();
  for (const key of ['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL']) {
    const url = new URL(process.env[key] ?? '');
    if (url.protocol !== 'postgresql:' || url.hostname !== 'localhost' || url.port !== '5432'
      || url.pathname !== '/hon_hq_schools_validation' || url.search || url.hash || !url.password
      || url.username !== (key === 'DATABASE_URL' ? 'hon_hq_schools_owner' : 'hon_hq_schools_runtime')) {
      throw new Error('HQ school-directory validation requires exact guarded disposable localhost aliases.');
    }
  }
}
