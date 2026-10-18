const setupSelectors = new Set(['HON_CRM_INTAKE_STAGES_VALIDATION_TARGET', 'HON_CRM_INTAKE_STAGES_ENV_FILE']);
const externalPrefix = /^(?:OPENROUTER|DIRECT_LLM_API|HEYGEN|HIGGSFIELD|OPENAI|ANTHROPIC|GOOGLE|STRIPE|SQUARE|TWILIO|SHOPIFY|META|FACEBOOK|INSTAGRAM|TIKTOK|SENDGRID|MAILGUN|POSTMARK|SLACK|DISCORD|AWS|AZURE|GCP|GOOGLE_CLOUD|SUPABASE)(?:_|$)/i;
const credentialName = /(?:^|_)(?:API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|PRIVATE_KEY)(?:_|$)/i;
const executionPrefix = /^(?:HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER)|(?:PROVIDER|EXECUTION|WORKER|CONSUMER|DELIVERY|PAYMENT|MESSAGING|COMMUNICATION|ACTION_ENGINE))(?:_|$)/i;

export function refuseCrmIntakeStagesExternalEnvironment() {
  const risky = Object.keys(process.env).filter((key) => !setupSelectors.has(key) && (externalPrefix.test(key) || credentialName.test(key) || executionPrefix.test(key)));
  if (risky.length) throw new Error(`CRM intake-stage local validation refuses provider/payment/messaging credentials or execution switches (${risky.join(', ')}).`);
}

export function requireCrmIntakeStagesLocalUrls() {
  refuseCrmIntakeStagesExternalEnvironment();
  for (const key of ['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL']) {
    let url;
    try { url = new URL(process.env[key] ?? ''); } catch { throw new Error('CRM intake-stage validation requires exact guarded disposable localhost aliases.'); }
    if (url.protocol !== 'postgresql:' || url.hostname !== 'localhost' || url.port !== '5432'
      || url.pathname !== '/hon_crm_intake_stages_validation' || url.search || url.hash || !url.password
      || url.username !== (key === 'DATABASE_URL' ? 'hon_crm_intake_stages_owner' : 'hon_crm_intake_stages_runtime')) {
      throw new Error('CRM intake-stage validation requires exact guarded disposable localhost aliases.');
    }
  }
}
