const setupSelectors = new Set(['HON_CURRICULUM_LIBRARY_VALIDATION_TARGET', 'HON_CURRICULUM_LIBRARY_ENV_FILE']);
const externalPrefix = /^(?:OPENROUTER|DIRECT_LLM_API|HEYGEN|HIGGSFIELD|OPENAI|ANTHROPIC|GOOGLE|STRIPE|SQUARE|TWILIO|SHOPIFY|META|FACEBOOK|INSTAGRAM|TIKTOK|SENDGRID|MAILGUN|POSTMARK|SLACK|DISCORD|AWS|AZURE|GCP|GOOGLE_CLOUD|SUPABASE)(?:_|$)/i;
const credentialName = /(?:^|_)(?:API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|PRIVATE_KEY)(?:_|$)/i;
const embeddedExecution = /(?:^|_)(?:PROVIDER|EXECUTION|WORKER|CONSUMER|DELIVERY|PAYMENT|MESSAGING|COMMUNICATION|ACTION_ENGINE)(?:_|$)/i;
const executionPrefix = /^(?:HON_)?(?:AI|ACTION(?:_ENGINE)?|PROVIDER(?:S)?|EXTERNAL|PAYMENT(?:S)?|COMMUNICATION(?:S)?|MESSAGING|MESSAGE(?:S)?|DELIVERY|PUBLISH|CONSUMER|WORKER|EXECUTION)(?:_|$)/i;

export function refuseCurriculumLibraryExternalEnvironment() {
  const risky = Object.keys(process.env).filter(key => !setupSelectors.has(key) && (externalPrefix.test(key) || executionPrefix.test(key) || credentialName.test(key) || embeddedExecution.test(key)));
  if (risky.length) throw new Error(`CurriculumLibrary local validation refuses recognized provider/payment/messaging credentials, live gates, or execution switches (${risky.join(', ')}).`);
}

export function requireCurriculumLibraryLocalUrls() {
  refuseCurriculumLibraryExternalEnvironment();
  for (const key of ['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL']) {
    const url = new URL(process.env[key] ?? '');
    if (url.protocol !== 'postgresql:' || url.hostname !== 'localhost' || url.port !== '5432'
      || url.pathname !== '/hon_curriculum_library_validation' || url.search || url.hash || !url.password
      || url.username !== (key === 'DATABASE_URL' ? 'hon_curriculum_library_owner' : 'hon_curriculum_library_runtime')) {
      throw new Error('CurriculumLibrary validation requires exact guarded disposable localhost aliases.');
    }
  }
}
