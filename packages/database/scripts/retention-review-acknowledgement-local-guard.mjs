const setupSelectors = new Set(['HON_RETENTION_ACKNOWLEDGEMENT_VALIDATION_TARGET', 'HON_RETENTION_ACKNOWLEDGEMENT_ENV_FILE']);
const externalPrefix = /^(?:OPENROUTER|DIRECT_LLM_API|HEYGEN|HIGGSFIELD|OPENAI|ANTHROPIC|GOOGLE|STRIPE|SQUARE|TWILIO|SHOPIFY|META|FACEBOOK|INSTAGRAM|TIKTOK|SENDGRID|MAILGUN|POSTMARK|SLACK|DISCORD|AWS|AZURE|GCP|GOOGLE_CLOUD|SUPABASE)(?:_|$)/i;
const executionPrefix = /^(?:HON_)?(?:AI|ACTION(?:_ENGINE)?|PROVIDER(?:S)?|EXTERNAL|PAYMENT(?:S)?|COMMUNICATION(?:S)?|MESSAGING|MESSAGE(?:S)?|DELIVERY|PUBLISH|CONSUMER|WORKER|EXECUTION)(?:_|$)/i;

export function refuseRetentionAcknowledgementExternalEnvironment() {
  if (['NODE_ENV','HON_ENV','HON_ENVIRONMENT','APP_ENV','ENVIRONMENT'].some(key => /^(?:prod(?:uction)?|live)$/i.test(process.env[key] ?? ''))) throw new Error('Retention acknowledgement validation refuses production/live environments.');
  if (Object.keys(process.env).some(key => /^PG(?:HOST|PORT|USER|PASSWORD|DATABASE|SERVICE|SSLMODE|OPTIONS|PASSFILE)/i.test(key))) throw new Error('Retention acknowledgement validation refuses inherited PostgreSQL overrides.');
  const risky = Object.keys(process.env).filter(key => !setupSelectors.has(key) && (externalPrefix.test(key) || executionPrefix.test(key)));
  if (risky.length) throw new Error(`RetentionAcknowledgement local validation refuses recognized provider/payment/messaging credentials, live gates, or execution switches (${risky.join(', ')}).`);
}

export function requireRetentionAcknowledgementLocalUrls() {
  refuseRetentionAcknowledgementExternalEnvironment();
  for (const key of ['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL']) {
    const url = new URL(process.env[key] ?? '');
    if (url.protocol !== 'postgresql:' || url.hostname !== 'localhost' || url.port !== '5432'
      || url.pathname !== '/hon_retention_acknowledgement_validation' || url.search || url.hash || !url.password
      || url.username !== (key === 'DATABASE_URL' ? 'hon_retention_acknowledgement_owner' : 'hon_retention_acknowledgement_runtime')) {
      throw new Error('RetentionAcknowledgement validation requires exact guarded disposable localhost aliases.');
    }
  }
}
