const setupSelectors = new Set(['HON_CLASSPASS_VALIDATION_TARGET', 'HON_CLASSPASS_ENV_FILE']);
const externalPrefix = /^(?:OPENROUTER|DIRECT_LLM_API|HEYGEN|HIGGSFIELD|OPENAI|ANTHROPIC|GOOGLE|STRIPE|SQUARE|TWILIO|SHOPIFY|META|FACEBOOK|INSTAGRAM|TIKTOK|SENDGRID|MAILGUN|POSTMARK|SLACK|DISCORD|AWS|AZURE|GCP|GOOGLE_CLOUD|SUPABASE)(?:_|$)/i;
const executionPrefix = /^(?:HON_)?(?:AI|ACTION(?:_ENGINE)?|PROVIDER(?:S)?|EXTERNAL|PAYMENT(?:S)?|COMMUNICATION(?:S)?|MESSAGING|MESSAGE(?:S)?|DELIVERY|PUBLISH|CONSUMER|WORKER|EXECUTION)(?:_|$)/i;

export function refuseClassPassExternalEnvironment() {
  const risky = Object.keys(process.env).filter(key => !setupSelectors.has(key) && (externalPrefix.test(key) || executionPrefix.test(key)));
  if (risky.length) throw new Error(`ClassPass local validation refuses recognized provider/payment/messaging credentials, live gates, or execution switches (${risky.join(', ')}).`);
}

export function requireClassPassLocalUrls() {
  refuseClassPassExternalEnvironment();
  for (const key of ['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL']) {
    const url = new URL(process.env[key] ?? '');
    if (url.protocol !== 'postgresql:' || url.hostname !== 'localhost' || url.port !== '5432'
      || url.pathname !== '/hon_classpass_validation' || url.search || url.hash || !url.password
      || url.username !== (key === 'DATABASE_URL' ? 'hon_classpass_owner' : 'hon_classpass_runtime')) {
      throw new Error('ClassPass validation requires exact guarded disposable localhost aliases.');
    }
  }
}
