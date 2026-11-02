import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  MEMBERSHIP_ACTIVATION_WARNING_CODES, MEMBERSHIP_ACTIVATION_BLOCK_CODES, MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED,
  MEMBERSHIP_ACTIVATION_SOURCES, MEMBERSHIP_ACTIVATION_REASON_CODES,
} from '@hon/contracts';
import { warningText, blockText, requirementText, sourceText, reasonText } from '../src/components/membership-activation-copy';
import {
  activationEnglish, activationCatalogs, activationText, activationWarning, activationBlock, activationRequirement,
  activationSource, activationReason, activationError, type ActivationTextKey,
} from '../src/components/membership-activation-catalog';

const languages = ['en','ko','es'] as const;
const placeholders = (value: string) => [...value.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort();

it('has complete nonempty EN/KO/ES catalogs with identical closed English keys and vetted placeholders', () => {
  const keys = Object.keys(activationEnglish) as ActivationTextKey[];
  for (const language of languages) {
    expect(Object.keys(activationCatalogs[language])).toEqual(keys);
    for (const key of keys) {
      const value = activationCatalogs[language][key]; expect(value.trim()).not.toBe('');
      expect(placeholders(value)).toEqual(placeholders(key));
      expect(placeholders(value).every(name => ['name','date','version'].includes(name!))).toBe(true);
      if (language === 'en') expect(value).toBe(key);
    }
  }
  expect(Object.isFrozen(activationEnglish)).toBe(true);
});

function verifyCodes<T extends string>(codes: readonly T[], english: Record<T, string>, translate: (language: string, code: T) => string): void {
  for (const code of codes) {
    expect(translate('en', code)).toBe(english[code]);
    for (const language of ['ko','es']) {
      expect(translate(language, code).trim()).not.toBe('');
      expect(translate(language, code)).not.toBe(english[code]);
    }
  }
}
it('preserves every existing English warning, block, requirement, source and reason export while translating actual contract codes', () => {
  verifyCodes(MEMBERSHIP_ACTIVATION_WARNING_CODES, warningText, activationWarning);
  verifyCodes(MEMBERSHIP_ACTIVATION_BLOCK_CODES, blockText, activationBlock);
  verifyCodes(MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED, requirementText, activationRequirement);
  verifyCodes(MEMBERSHIP_ACTIVATION_SOURCES, sourceText, activationSource);
  verifyCodes(MEMBERSHIP_ACTIVATION_REASON_CODES, reasonText, activationReason);
});

it('includes the CRM handoff, current-observation, operations, appearance and retry captions without private record facts', () => {
  const keys: ActivationTextKey[] = [
    'Review membership activation', 'Return to CRM registration', 'Membership reference selected from CRM; review current facts before confirming.',
    'Check current membership status', 'Current lifecycle observation; effective status, payment and agreement are not verified by this read.',
    'Continue school operations', 'Class bookings', 'Attendance', 'These links do not book a class, record attendance or prove payment.',
    'Presentation', 'Modern', 'Classic', 'Big Button', 'Verify access before retrying the exact original request.', 'Name unavailable',
  ];
  for (const key of keys) for (const language of languages) expect(activationText(language, key)).toBe(activationCatalogs[language][key]);
  expect(JSON.stringify(activationCatalogs)).not.toMatch(/PRIVATE_CANARY|example\.invalid|studentProfileId|previewDigest/);
});

it('interpolates vetted placeholders once as plain text and leaves absent or invalid values visible', () => {
  expect(activationText('ko', 'Membership confirmed — scheduled to begin {date}.', { date: '2026-11-30' })).toBe('회원권 확인 완료 — 2026-11-30에 시작 예정입니다.');
  expect(activationText('es', 'version {version}', { version: 12 })).toBe('versión 12');
  expect(activationText('en', 'Plan suggestion: {date}.', { date: '$&{version}<script>' })).toBe('Plan suggestion: $&{version}<script>.');
  expect(activationText('en', 'version {version}')).toBe('version {version}');
  expect(activationText('en', 'version {version}', { version: Number.NaN })).toBe('version {version}');
  expect(activationText('en', 'version {version}', Object.create({ version: 3 }))).toBe('version {version}');
});

it('uses English for unsupported languages and a fixed unavailable caption for unsupported runtime codes', () => {
  for (const language of ['future-language','__proto__','constructor']) expect(activationText(language, 'Name unavailable')).toBe('Name unavailable');
  expect(activationWarning('es', 'UNKNOWN_PRIVATE_CODE' as never)).toBe(activationText('es', 'Unavailable'));
  expect(activationText('ko', 'UNKNOWN_PRIVATE_KEY' as never)).toBe(activationText('ko', 'Unavailable'));
});

it('maps every actual transport error code to its unchanged English meaning and fixed translated text', () => {
  const source = readFileSync(new URL('../src/components/membership-activation-http.ts', import.meta.url), 'utf8');
  const messages = source.slice(source.indexOf('const messages:'), source.indexOf('\n};', source.indexOf('const messages:')));
  const codes = [...messages.matchAll(/^\s+([A-Z_]+): /gm)].map(match => match[1]!);
  expect(codes.length).toBeGreaterThanOrEqual(17);
  for (const code of codes) {
    const english = activationError('en', { status: 409, code, uncertain: code === 'IDEMPOTENCY_IN_PROGRESS' });
    expect(messages).toContain(`${code}: '${english}'`);
    for (const language of ['ko','es']) expect(activationError(language, { status: 409, code })).not.toBe(english);
  }
});

it('preserves session, known-code, denied, uncertain and definite-refusal error precedence without echoing backend content', () => {
  for (const language of languages) {
    expect(activationError(language, { status: 401, code: 'VERSION_CONFLICT', uncertain: true })).toBe(activationText(language, 'Your session has expired. Sign in again before verifying access.'));
    expect(activationError(language, { status: 403, code: 'ACTIVATION_OVERRIDE_FORBIDDEN' })).toBe(activationText(language, 'Your current school permissions do not allow this override. Ask an appropriately authorized staff member to review.'));
    expect(activationError(language, { status: 403 })).toBe(activationText(language, 'Your current school access, activation permission or billing entitlement is unavailable.'));
    expect(activationError(language, { status: 503, code: 'PRIVATE_CANARY', uncertain: true })).toBe(activationText(language, 'The outcome is unknown. No activation is assumed. Retry only the exact retained request.'));
    expect(activationError(language, { status: 409, code: 'constructor' })).toBe(activationText(language, 'The request was refused. Review current school access and membership facts before trying again.'));
    expect(activationError(language, { status: 0, code: 'PRIVATE_CANARY', uncertain: true })).not.toContain('PRIVATE_CANARY');
  }
});

it('keeps scheduled membership, inclusive dates and unresolved identity review distinct from financial completion', () => {
  expect(activationText('en', 'Membership confirmed — scheduled to begin {date}.', { date: '2027-01-01' })).toBe('Membership confirmed — scheduled to begin 2027-01-01.');
  expect(activationText('ko', 'Last valid day (inclusive)')).toContain('당일 포함');
  expect(activationText('es', 'Last valid day (inclusive)')).toContain('inclusive');
  expect(activationWarning('ko', 'START_DATE_IN_FUTURE')).toContain('현재 유효해지는 것은 아닙니다');
  expect(activationWarning('es', 'START_DATE_IN_FUTURE')).toContain('no hace que esté vigente ahora');
  expect(activationText('ko', 'Identity-review override recorded. The review remains unresolved.')).toContain('미해결');
  expect(activationText('es', 'This is not payment, agreement, consent, recurring authorization or financially complete enrollment evidence.')).toContain('no es evidencia');
});
