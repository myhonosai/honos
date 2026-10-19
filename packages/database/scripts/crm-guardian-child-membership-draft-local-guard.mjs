const setupSelectors = new Set(['HON_CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_VALIDATION_TARGET', 'HON_CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_ENV_FILE']);
const externalPrefix = /^(?:OPENROUTER|DIRECT_LLM_API|HEYGEN|HIGGSFIELD|OPENAI|ANTHROPIC|GOOGLE|STRIPE|SQUARE|TWILIO|SHOPIFY|META|FACEBOOK|INSTAGRAM|TIKTOK|SENDGRID|MAILGUN|POSTMARK|SLACK|DISCORD|AWS|AZURE|GCP|GOOGLE_CLOUD|SUPABASE)(?:_|$)/i;
const credentialName = /(?:^|_)(?:API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|PRIVATE_KEY)(?:_|$)/i;
const executionPrefix = /^(?:HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER)|(?:PROVIDER|EXECUTION|WORKER|CONSUMER|DELIVERY|PAYMENT|MESSAGING|COMMUNICATION|ACTION_ENGINE))(?:_|$)/i;

export function refuseCrmGuardianChildMembershipDraftExternalEnvironment() {
  const risky = Object.keys(process.env).filter((key) => !setupSelectors.has(key)
    && (externalPrefix.test(key) || credentialName.test(key) || executionPrefix.test(key)));
  if (risky.length) throw new Error(`Guardian-child CRM membership DRAFT validation refuses provider/payment/messaging credentials or execution switches (${risky.join(', ')})`);
}

export function requireCrmGuardianChildMembershipDraftLocalUrls() {
  refuseCrmGuardianChildMembershipDraftExternalEnvironment();
  for (const key of ['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL']) {
    const url = new URL(process.env[key] ?? '');
    if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || url.port !== '55436'
      || url.pathname !== '/hon_crm_guardian_child_membership_draft_validation' || url.search || url.hash || !url.password
      || url.username !== (key === 'DATABASE_URL' ? 'hon_crm_guardian_child_membership_draft_owner' : 'hon_crm_guardian_child_membership_draft_runtime')) {
      throw new Error('Guardian-child CRM membership DRAFT validation requires exact guarded disposable localhost aliases.');
    }
  }
}
