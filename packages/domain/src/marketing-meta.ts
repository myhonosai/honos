import { META_CAPABILITIES, validateMetaConnectionIntent, validateMetaSchoolSelector,
  validateMetaUnavailableHealth, type MetaUnavailableHealth } from '@hon/contracts';

/**
 * Pure intent preview, NOT an authorization check. Callers must independently resolve
 * the live human/school/permissions and verify discovered assets before any future API.
 */
export function previewMetaConnectionIntent(value: unknown, serverSelectedSchoolId: unknown) {
  const intent = validateMetaConnectionIntent(value);
  if (intent.schoolId !== validateMetaSchoolSelector(serverSelectedSchoolId)) throw new Error('META_SCHOOL_SELECTION_MISMATCH');
  return Object.freeze({ intent, evidence: 'UNVERIFIED_SELECTION_ONLY' as const,
    connectionEstablished: false as const, providerPermissionVerified: false as const,
    externalExecutionAvailable: false as const });
}

/** Static implementation health only; contains no account, credentials or invented provider activity. */
export function metaFoundationHealth(): MetaUnavailableHealth {
  return validateMetaUnavailableHealth({ provider: 'META', configuration: 'UNCONFIGURED',
    connection: 'NOT_CONNECTED', externalExecutionAvailable: false, automatedActionsAvailable: false,
    capabilities: META_CAPABILITIES.map(capability => ({ capability, state: 'UNAVAILABLE',
      reason: 'META_RUNTIME_NOT_IMPLEMENTED' })) });
}
