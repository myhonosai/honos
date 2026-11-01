import { describe, expect, it, vi } from 'vitest';
import { META_ASSET_KINDS, META_CAPABILITIES, validateMetaConnectionIntent,
  validateMetaUnavailableHealth } from '@hon/contracts';
import { metaFoundationHealth, previewMetaConnectionIntent } from './marketing-meta.js';

const school = '10000000-0000-4000-8000-000000000001';
const otherSchool = '10000000-0000-4000-8000-000000000002';
function intent() {
  return { schemaVersion: 1, schoolId: school, loginRoute: 'FACEBOOK_BUSINESS_LOGIN', assets: [
    { assetKind: 'FACEBOOK_PAGE', providerAssetId: 'page-1', requestedCapabilities: ['PUBLISHING'] },
  ] };
}

describe('META-1 closed selection intent, not a connected account or permission', () => {
  it('previews one exact school without inventing a grant or execution readiness', () => {
    expect(previewMetaConnectionIntent(intent(), school)).toMatchObject({ evidence: 'UNVERIFIED_SELECTION_ONLY',
      connectionEstablished: false, providerPermissionVerified: false, externalExecutionAvailable: false });
  });

  it('never inherits the selection of another school, including within an organization', () => {
    expect(() => previewMetaConnectionIntent(intent(), otherSchool)).toThrow('META_SCHOOL_SELECTION_MISMATCH');
  });

  it.each([null, undefined, '*', '', 123, school + ' ', 'organization/all'])('rejects invalid school selector %s', schoolId => {
    expect(() => previewMetaConnectionIntent({ ...intent(), schoolId }, school)).toThrow();
    expect(() => previewMetaConnectionIntent(intent(), schoolId)).toThrow();
  });

  it.each([
    { token: 'not-a-real-token' }, { accessToken: 'not-a-real-token' }, { appSecret: 'not-a-real-secret' },
    { actorId: school }, { organizationId: school }, { role: 'OWNER' }, { tier: 'COMPLETE' },
    { permissions: ['*'] }, { connected: true }, { approved: true }, { grantedScopes: ['ads_management'] },
    { redirectUrl: 'https://example.invalid/return' }, { mode: 'AI_AUTOMATED' }, { locationId: '*' },
  ])('rejects unsupported credentials, authority, routing or automation: %j', extra => {
    expect(() => validateMetaConnectionIntent({ ...intent(), ...extra })).toThrow('INVALID_META_CONNECTION_INTENT');
  });

  it.each([
    null, [], {}, { ...intent(), schemaVersion: 2 }, { ...intent(), loginRoute: 'UNIVERSAL_TOKEN' },
    { ...intent(), schoolId: undefined }, { ...intent(), assets: [] },
    { ...intent(), assets: new Array(1) }, { ...intent(), assets: Array(21).fill(intent().assets[0]) },
  ])('rejects malformed or unbounded input %j', value => {
    expect(() => validateMetaConnectionIntent(value)).toThrow();
  });

  it.each([
    { parentPageId: 'page-2' }, { schoolId: otherSchool }, { organizationId: otherSchool },
    { authorized: true }, { messagingAllowed: true }, { displayName: 'Unverified Page' },
  ])('refuses client-owned asset relationships or facts: %j', extra => {
    expect(() => validateMetaConnectionIntent({ ...intent(), assets: [{ ...intent().assets[0], ...extra }] })).toThrow();
  });

  it.each(['', ' bad', 'https://example.invalid/asset', '../secret', 'a'.repeat(129), 'page\n1'])('rejects unsafe asset selector %j', providerAssetId => {
    expect(() => validateMetaConnectionIntent({ ...intent(), assets: [{ ...intent().assets[0], providerAssetId }] })).toThrow();
  });

  it('does not echo rejected credential values into errors', () => {
    const secret = 'NOT-A-REAL-SECRET';
    try { validateMetaConnectionIntent({ ...intent(), token: secret }); throw new Error('expected rejection'); }
    catch (error) { expect((error as Error).message).toBe('INVALID_META_CONNECTION_INTENT'); }
  });

  it('rejects accessor and inherited authority without evaluating getters', () => {
    const get = vi.fn(() => school);
    const accessor = Object.defineProperty({ ...intent() }, 'schoolId', { get });
    expect(() => validateMetaConnectionIntent(accessor)).toThrow(); expect(get).not.toHaveBeenCalled();
    expect(() => validateMetaConnectionIntent(Object.create(intent()))).toThrow();
    expect(() => validateMetaConnectionIntent({ ...intent(), [Symbol('authority')]: true })).toThrow();
  });

  it('rejects duplicate assets and capabilities instead of creating ambiguous grants', () => {
    const asset = intent().assets[0]!;
    expect(() => validateMetaConnectionIntent({ ...intent(), assets: [asset, asset] })).toThrow();
    expect(() => validateMetaConnectionIntent({ ...intent(), assets: [{ ...asset, requestedCapabilities: ['MESSAGING', 'MESSAGING'] }] })).toThrow();
    expect(() => validateMetaConnectionIntent({ ...intent(), assets: [{ ...asset, requestedCapabilities: new Array(1) }] })).toThrow();
    expect(() => validateMetaConnectionIntent({ ...intent(), assets: [{ ...asset, requestedCapabilities: [] }] })).toThrow();
  });

  it('keeps distinct Pages and their requested capabilities separate', () => {
    const output = validateMetaConnectionIntent({ ...intent(), assets: [
      intent().assets[0], { assetKind: 'FACEBOOK_PAGE', providerAssetId: 'page-2', requestedCapabilities: ['MESSAGING'] },
    ] });
    expect(output.assets[0]!.requestedCapabilities).toEqual(['PUBLISHING']);
    expect(output.assets[1]!.requestedCapabilities).toEqual(['MESSAGING']);
  });

  it('normalizes detached immutable data, with no implicitly added capabilities', () => {
    const input = intent(); input.assets[0]!.requestedCapabilities = ['SOCIAL_INSIGHTS', 'COMMENTS'];
    const output = validateMetaConnectionIntent(input);
    input.assets[0]!.providerAssetId = 'changed'; input.assets[0]!.requestedCapabilities.push('MESSAGING');
    expect(output.assets[0]!).toMatchObject({ providerAssetId: 'page-1', requestedCapabilities: ['COMMENTS', 'SOCIAL_INSIGHTS'] });
    expect(Object.isFrozen(output)).toBe(true); expect(Object.isFrozen(output.assets)).toBe(true);
    expect(Object.isFrozen(output.assets[0])).toBe(true); expect(Object.isFrozen(output.assets[0]!.requestedCapabilities)).toBe(true);
  });

  it('canonicalizes reordering without changing provider identifiers', () => {
    const a = { assetKind: 'AD_ACCOUNT', providerAssetId: 'act_12', requestedCapabilities: ['ADS_MANAGEMENT', 'ADS_REPORTING'] };
    const b = { ...intent().assets[0]!, providerAssetId: 'Page-AbC' };
    const left = validateMetaConnectionIntent({ ...intent(), assets: [a, b] });
    const right = validateMetaConnectionIntent({ ...intent(), assets: [b, { ...a, requestedCapabilities: [...a.requestedCapabilities].reverse() }] });
    expect(left).toEqual(right); expect(left.assets[1]!.providerAssetId).toBe('Page-AbC');
  });
});

describe('Meta independent product capabilities (compatibility only)', () => {
  const allowed: Record<string, string[]> = {
    FACEBOOK_PAGE: ['PUBLISHING', 'COMMENTS', 'MESSAGING', 'SOCIAL_INSIGHTS'],
    INSTAGRAM_PROFESSIONAL_ACCOUNT: ['PUBLISHING', 'COMMENTS', 'MESSAGING', 'SOCIAL_INSIGHTS'],
    AD_ACCOUNT: ['ADS_REPORTING', 'ADS_MANAGEMENT'], LEAD_FORM: ['LEAD_RETRIEVAL'],
  };
  it.each(META_ASSET_KINDS.flatMap(assetKind => META_CAPABILITIES.map(capability => [assetKind, capability] as const)))(
    'keeps %s / %s compatibility independent', (assetKind, capability) => {
      const value = { ...intent(), assets: [{ assetKind, providerAssetId: 'opaque-1', requestedCapabilities: [capability] }] };
      if (allowed[assetKind]!.includes(capability)) {
        expect(previewMetaConnectionIntent(value, school).providerPermissionVerified).toBe(false);
      } else expect(() => validateMetaConnectionIntent(value)).toThrow();
    });

  it.each(['FACEBOOK_PAGE', 'AD_ACCOUNT', 'LEAD_FORM'])('Instagram login does not authorize %s', assetKind => {
    expect(() => validateMetaConnectionIntent({ ...intent(), loginRoute: 'INSTAGRAM_LOGIN', assets: [
      { assetKind, providerAssetId: 'opaque-1', requestedCapabilities: allowed[assetKind]!.slice(0, 1) },
    ] })).toThrow();
  });

  it('allows professional Instagram selection without claiming messaging eligibility or granted permission', () => {
    const value = { ...intent(), loginRoute: 'INSTAGRAM_LOGIN', assets: [{ assetKind: 'INSTAGRAM_PROFESSIONAL_ACCOUNT',
      providerAssetId: 'ig-1', requestedCapabilities: ['MESSAGING'] }] };
    expect(previewMetaConnectionIntent(value, school)).toMatchObject({ providerPermissionVerified: false, connectionEstablished: false });
  });
});

describe('Meta unconfigured health is honest and has no external side effects', () => {
  it('reports every capability unavailable without credential or activity fields', () => {
    const health = metaFoundationHealth();
    expect(health.configuration).toBe('UNCONFIGURED'); expect(health.connection).toBe('NOT_CONNECTED');
    expect(health.externalExecutionAvailable).toBe(false); expect(health.automatedActionsAvailable).toBe(false);
    expect(health.capabilities.map(c => c.capability)).toEqual([...META_CAPABILITIES]);
    expect(health.capabilities.every(c => c.state === 'UNAVAILABLE' && c.reason === 'META_RUNTIME_NOT_IMPLEMENTED')).toBe(true);
    expect(Object.isFrozen(health)).toBe(true); expect(Object.isFrozen(health.capabilities)).toBe(true);
    expect(health.capabilities.every(Object.isFrozen)).toBe(true);
  });

  it.each([
    { configuration: 'CONNECTED' }, { connection: 'READY' }, { externalExecutionAvailable: true },
    { automatedActionsAvailable: true }, { token: 'fake' }, { messagesSent: 5 },
  ])('refuses forged readiness or activity: %j', patch => {
    expect(() => validateMetaUnavailableHealth({ ...metaFoundationHealth(), ...patch })).toThrow();
  });

  it('rejects partial, reordered and upgraded capability health', () => {
    const health = metaFoundationHealth();
    expect(() => validateMetaUnavailableHealth({ ...health, capabilities: health.capabilities.slice(1) })).toThrow();
    expect(() => validateMetaUnavailableHealth({ ...health, capabilities: [...health.capabilities].reverse() })).toThrow();
    expect(() => validateMetaUnavailableHealth({ ...health, capabilities: health.capabilities.map(c => ({ ...c, state: 'AVAILABLE' })) })).toThrow();
  });

  it('runs previews without fetching providers or starting timers/workers', () => {
    const fetch = vi.fn(() => { throw new Error('external provider forbidden'); });
    const timer = vi.spyOn(globalThis, 'setTimeout');
    vi.stubGlobal('fetch', fetch);
    try { previewMetaConnectionIntent(intent(), school); metaFoundationHealth();
      expect(fetch).not.toHaveBeenCalled(); expect(timer).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); timer.mockRestore(); }
  });
});
