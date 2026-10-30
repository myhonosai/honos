import { A2P_ENGINE_VERSION, A2P_FINDING_CODES, A2P_FACT_CONFIRMATION, a2pPublicHttpsUrl, a2pText,
  validateA2pDraftInput, type A2pDraft, type A2pDraftInput, type A2pEvidence, type A2pFindingCode,
  type A2pSource, type A2pWebsiteReview, type A2pTemplate } from '@hon/contracts';

export const A2P_SOURCES: readonly A2pSource[] = Object.freeze([
  { id: 'TWILIO_CAMPAIGN_FIELDS', url: 'https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/collect-business-info', reviewedOn: '2026-10-25' },
  { id: 'TWILIO_OPT_IN_GUIDANCE', url: 'https://help.twilio.com/hc/en-us/articles/11847054539547-A2P-10DLC-Campaign-Approval-Best-Practices', reviewedOn: '2026-10-25' },
  { id: 'TWILIO_SMS_SHARING', url: 'https://www.twilio.com/docs/api/errors/30932', reviewedOn: '2026-10-25' },
  { id: 'TWILIO_VOLUNTARY_CONSENT', url: 'https://www.twilio.com/docs/api/errors/30923', reviewedOn: '2026-10-25' },
].map(source => Object.freeze(source as A2pSource)));

const remediation: Record<A2pFindingCode, string> = {
  BUSINESS_IDENTITY: 'Have the owner reconcile the business/trade name, school identity, website and registration facts.',
  PRIVACY_PUBLIC: 'Provide a public privacy-policy page accessible without signing in, with the required SMS disclosures.',
  TERMS_PUBLIC: 'Provide public terms on the business website; do not use an inaccessible or unrelated-domain document.',
  SMS_DATA_SHARING: 'Review mobile-number and SMS-consent non-sharing language; resolve contradictory sharing claims.',
  OPT_IN_PUBLIC: 'Identify the actual public SMS opt-in location or an appropriate reviewable proof of the flow.',
  CONSENT_OPTIONAL_UNCHECKED: 'Use a separate, optional, initially unchecked SMS consent control; avoid requiring it for service.',
  CONSENT_SEPARATION: 'Review separate marketing and transactional consent; accepting general terms is not SMS consent.',
  FREQUENCY: 'State the actual message frequency in the opt-in disclosures and applicable policy.',
  RATES: 'Include the applicable message-and-data-rates disclosure near the opt-in and in the relevant policy.',
  STOP: 'Describe STOP opt-out instructions and verify the actual provider/application behavior before use.',
  HELP: 'Describe HELP instructions and a real business support contact; verify the actual help behavior.',
  POLICY_LINKS_NEAR_FORM: 'Place working privacy/terms links by the actual SMS opt-in controls.',
  FLOW_CONSISTENCY: 'Make registration claims match every real consent method; do not invent double opt-in, welcome or recording steps.',
};
export interface A2pFixtureObservation {
  readonly code: A2pFindingCode;
  readonly outcome: 'PRESENT' | 'MISSING' | 'CONTRADICTORY' | 'DYNAMIC_UNKNOWN';
  readonly evidence: readonly A2pEvidence[];
}
export type A2pInspection = { readonly kind: 'UNAVAILABLE'; readonly reason: 'LIVE_INSPECTION_DISABLED' | 'INSPECTION_FAILED' }
  | { readonly kind: 'SYNTHETIC_FIXTURE'; readonly observations: readonly A2pFixtureObservation[] };

/** Trusted-inspector input only. HTTP requests cannot contain observations/HTML or select this fixture mode. */
export function evaluateA2pWebsite(inspection: A2pInspection): A2pWebsiteReview {
  const observations = new Map<A2pFindingCode, A2pFixtureObservation>();
  if (inspection.kind === 'SYNTHETIC_FIXTURE') {
    if (inspection.observations.length > A2P_FINDING_CODES.length) throw new Error('INVALID_A2P_EVIDENCE');
    for (const o of inspection.observations) {
      if (!A2P_FINDING_CODES.includes(o.code) || observations.has(o.code)
        || !['PRESENT','MISSING','CONTRADICTORY','DYNAMIC_UNKNOWN'].includes(o.outcome) || o.evidence.length < 1 || o.evidence.length > 4) throw new Error('INVALID_A2P_EVIDENCE');
      for (const e of o.evidence) {
        if (e.provenance !== 'SYNTHETIC_FIXTURE' || !/^[A-Z0-9_-]{1,80}$/.test(e.id)
          || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(e.observedAt)
          || !Number.isFinite(Date.parse(e.observedAt)) || new Date(e.observedAt).toISOString() !== e.observedAt) throw new Error('INVALID_A2P_EVIDENCE');
        a2pPublicHttpsUrl(e.url); a2pText(e.excerpt, 500);
      }
      observations.set(o.code, o);
    }
  }
  const findings = A2P_FINDING_CODES.map(code => {
    const o = observations.get(code);
    const sourceIds = code === 'SMS_DATA_SHARING' ? ['TWILIO_SMS_SHARING']
      : ['CONSENT_OPTIONAL_UNCHECKED','CONSENT_SEPARATION','POLICY_LINKS_NEAR_FORM'].includes(code)
        ? ['TWILIO_VOLUNTARY_CONSENT','TWILIO_OPT_IN_GUIDANCE'] : ['TWILIO_CAMPAIGN_FIELDS'];
    const status = !o ? 'UNAVAILABLE' : o.outcome === 'PRESENT' ? 'PASS'
      : o.outcome === 'DYNAMIC_UNKNOWN' ? 'REVIEW_REQUIRED' : 'NEEDS_FIX';
    return Object.freeze({ code, status, reason: !o ? inspection.kind === 'UNAVAILABLE' ? inspection.reason : 'NO_OBSERVATION'
      : o.outcome === 'PRESENT' ? 'OBSERVED_IN_SYNTHETIC_FIXTURE' : o.outcome,
      remediation: remediation[code], sourceIds: Object.freeze(sourceIds),
      evidence: Object.freeze((o?.evidence ?? []).map(e => Object.freeze({ ...e }))) });
  });
  return Object.freeze({ engineVersion: A2P_ENGINE_VERSION,
    inspection: inspection.kind === 'SYNTHETIC_FIXTURE' ? 'SYNTHETIC_FIXTURE' : 'LIVE_INSPECTION_DISABLED',
    overallStatus: inspection.kind === 'UNAVAILABLE' ? 'UNAVAILABLE' : findings.some(f => f.status === 'NEEDS_FIX') ? 'NEEDS_FIX' : 'REVIEW_REQUIRED',
    findings: Object.freeze(findings), sources: A2P_SOURCES, carrierApproval: 'NOT_REQUESTED', legalCompliance: 'NOT_DETERMINED' });
}

const purposes: Record<A2pDraftInput['purpose'], string> = {
  SERVICE_NOTIFICATIONS: 'Requested trial, enrollment and school service notifications',
  MARKETING: 'Marketing messages to separately opted-in recipients',
  MIXED: 'Service notifications and separately consented marketing messages',
};
const descriptions: Record<A2pTemplate, string> = {
  TRIAL_CONFIRMATION: 'requested trial confirmations', TRIAL_REMINDER: 'requested trial reminders',
  ENROLLMENT_FOLLOW_UP: 'follow-up on requested enrollment information', CLASS_CHANGE: 'class changes',
  SCHOOL_CLOSURE: 'school closure notices', TUITION_NOTIFICATION: 'tuition account notifications', PROMOTIONAL: 'martial arts program promotions',
};
function message(t: A2pTemplate, f: A2pDraftInput['facts'], alternate = false): string {
  const b = f.businessName!, end = ' Reply STOP to opt out; HELP for help.';
  const copy: Record<A2pTemplate, readonly [string,string]> = {
    TRIAL_CONFIRMATION: [`${b}: Your requested trial is scheduled for [trial_date] at [trial_time].`, `${b}: Trial confirmation for [student_name]: [trial_date], [trial_time].`],
    TRIAL_REMINDER: [`${b}: Reminder of your requested trial on [trial_date] at [trial_time].`, `${b}: We look forward to your scheduled trial at [trial_time] on [trial_date].`],
    ENROLLMENT_FOLLOW_UP: [`${b}: Following up on your requested enrollment information. Contact ${f.supportContact} with questions.`, `${b}: Have questions about the enrollment information you requested? Contact ${f.supportContact}.`],
    CLASS_CHANGE: [`${b}: Your [class_name] on [class_date] has changed to [new_time].`, `${b}: Schedule update for [class_name]: [class_date], [new_time].`],
    SCHOOL_CLOSURE: [`${b}: The school will be closed on [closure_date]. Contact ${f.supportContact} for schedule questions.`, `${b}: Closure notice for [closure_date]. Please check your next class with ${f.supportContact}.`],
    TUITION_NOTIFICATION: [`${b}: A tuition account notice is available. Contact ${f.supportContact} to review your account securely.`, `${b}: Please contact ${f.supportContact} about your tuition account notice. Do not send payment details by SMS.`],
    PROMOTIONAL: [`${b}: Interested in our martial arts programs? See ${f.websiteUrl} for current information.`, `${b}: Explore our martial arts classes at ${f.websiteUrl}. Contact ${f.supportContact} to learn more.`],
  };
  return copy[t][alternate ? 1 : 0] + end;
}
function sameBusinessHost(a: string, b: string): boolean { return a2pPublicHttpsUrl(a).split('/')[2]!.replace(/^www\./,'') === a2pPublicHttpsUrl(b).split('/')[2]!.replace(/^www\./,''); }

/** Immutable v1 deterministic templates. No AI call, provider category selection, consent record or stored acceptance. */
export function generateA2pDraft(value: unknown, verifiedSchoolName: string): A2pDraft {
  const input = validateA2pDraftInput(value), f = input.facts;
  const missing = Object.entries(f).filter(([,v]) => v === null).map(([k]) => k);
  if (f.messageFlow !== null && f.messageFlow.length < 40) missing.push('messageFlow.minimum40Characters');
  if (input.ownerConfirmation !== A2P_FACT_CONFIRMATION) missing.push('ownerConfirmation');
  if (input.templates.includes('PROMOTIONAL') && input.marketingConsent !== 'SEPARATE_CONFIRMED') missing.push('marketingConsent.separateConfirmation');
  const warnings = ['OWNER_REVIEW_REQUIRED', 'WEBSITE_NOT_INDEPENDENTLY_INSPECTED', 'ALL_OPT_IN_METHODS_MUST_BE_DISCLOSED',
    'PROVIDER_USE_CASE_AND_BRAND_ELIGIBILITY_NOT_VERIFIED', 'HELP_STOP_SAMPLES_NOT_CONFIGURED', 'NO_LEGAL_OR_CARRIER_APPROVAL'];
  if (f.businessName && f.businessName.toLocaleLowerCase('en') !== verifiedSchoolName.toLocaleLowerCase('en')) warnings.push('BUSINESS_TRADE_NAME_REQUIRES_RECONCILIATION');
  if (f.websiteUrl && f.termsUrl && !sameBusinessHost(f.websiteUrl,f.termsUrl)) missing.push('termsUrl.businessDomainRequired');
  const messageFlow = f.messageFlow && f.privacyUrl && f.termsUrl
    ? `${f.messageFlow} Privacy policy: ${f.privacyUrl} Terms and conditions: ${f.termsUrl}` : null;
  if (messageFlow && messageFlow.length>2048) missing.push('messageFlow.withPolicyLinksMaximum2048');
  const help = f.businessName && f.supportContact ? `${f.businessName}: For help, contact ${f.supportContact}. Message and data rates may apply. Reply STOP to opt out.` : null;
  const stop = f.businessName && f.supportContact ? `${f.businessName}: You are unsubscribed from these SMS messages. No further messages will be sent. For help, contact ${f.supportContact}.` : null;
  if (help && help.length>320 || stop && stop.length>320) missing.push('helpStopSamples.maximum320Characters');
  const complete = missing.length === 0;
  let samples = complete ? input.templates.map(template => Object.freeze({ template, content: message(template,f) })) : [];
  if (complete && samples.length === 1) samples = [...samples, Object.freeze({ template: input.templates[0]!, content: message(input.templates[0]!,f,true) })];
  if (samples.some(s => s.content.length < 20 || s.content.length > 1024)) { missing.push('sampleMessages.length20To1024'); samples = []; }
  const ready = missing.length === 0;
  return Object.freeze({ engineVersion: A2P_ENGINE_VERSION, language: 'en', state: ready ? 'DRAFT_FOR_OWNER_REVIEW' : 'NEEDS_INPUT',
    missingFields: Object.freeze(missing), warnings: Object.freeze(warnings),
    answers: ready ? Object.freeze({ campaignUseCase: purposes[input.purpose],
      campaignDescription: `${f.businessName} plans SMS for ${input.templates.map(t => descriptions[t]).join(', ')} to recipients who have opted in through the owner-described flow. Stated frequency: ${f.messageFrequency}.`,
      messageFlow: messageFlow!, websiteUrl: f.websiteUrl!, privacyPolicyUrl: f.privacyUrl!, termsAndConditionsUrl: f.termsUrl!, optInUrl: f.optInUrl! }) : null,
    sampleMessages: Object.freeze(samples), helpResponseSample: ready ? help : null, stopResponseSample: ready ? stop : null,
    copyPreparationAvailable: ready, factsProvenance: 'OWNER_STATEMENTS_NOT_INDEPENDENTLY_VERIFIED', consentRecorded: false, saved: false, submitted: false, messagesSent: 0 });
}
