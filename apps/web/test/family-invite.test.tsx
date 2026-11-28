import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { familyInviteLink, parseFamilyInviteFragment, validateFamilyInvitationEmailInput, validateFamilyInvitationEmailReceipt } from '@hon/contracts';
import { FamilyInviteActivate } from '../src/components/family-invite/activate';
import { familyInviteText } from '../src/components/family-invite/copy';
import { FamilyInviteError, familyInviteApi } from '../src/components/family-invite/http';
import { FamilyInviteLanding, landFamilyInvite } from '../src/components/family-invite/landing';
import { dropFamilyInvite, keepFamilyInvite, readFamilyInvite } from '../src/components/family-invite/store';
import { mailAfterError } from '../src/components/people/card-family-access';
import { panelText } from '../src/components/people/panel-copy';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const token = 'A'.repeat(43), other = 'b'.repeat(43);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const memory = () => { const map = new Map<string, string>(); return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, removeItem: (k: string) => { map.delete(k); }, map }; };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('the emailed link carries the invitation only in the fragment, and only that exact form is read back', () => {
  const link = familyInviteLink('https://app.example.org', id(1), token);
  expect(link).toBe(`https://app.example.org/family-invite#i=${id(1)}&c=${token}`);
  expect(new URL(link).search).toBe('');
  expect(parseFamilyInviteFragment(new URL(link).hash)).toEqual({ invitationId: id(1), token });
  for (const bad of ['', '#', `#i=${id(1)}`, `#c=${token}&i=${id(1)}`, `#i=${id(1)}&c=${token}x`, `#i=${id(1)}&c=${token}&next=/hq`, `#i=nope&c=${token}`, `?i=${id(1)}&c=${token}`]) expect(parseFamilyInviteFragment(bad)).toBeNull();
  expect(() => familyInviteLink('https://app.example.org', 'x', token)).toThrow();
  expect(() => familyInviteLink('https://app.example.org', id(1), 'short')).toThrow();
});

it('the landing page takes the invitation out of the address at once and keeps it for this tab only', () => {
  const store = memory(), replaceState = vi.fn();
  vi.stubGlobal('sessionStorage', store); vi.stubGlobal('history', { replaceState });
  vi.stubGlobal('location', { hash: `#i=${id(1)}&c=${token}`, pathname: '/family-invite' });
  expect(landFamilyInvite()).toBe('READY');
  expect(replaceState).toHaveBeenCalledWith(null, '', '/family-invite');
  expect(readFamilyInvite()).toEqual({ invitationId: id(1), token });
  // A later visit with no fragment still finds it; a broken fragment is removed from the address and never replaces it.
  vi.stubGlobal('location', { hash: '', pathname: '/family-invite' }); expect(landFamilyInvite()).toBe('READY');
  vi.stubGlobal('location', { hash: '#i=broken', pathname: '/family-invite' }); expect(landFamilyInvite()).toBe('READY');
  expect(replaceState).toHaveBeenCalledTimes(2);
  dropFamilyInvite(); expect(readFamilyInvite()).toBeNull(); expect(store.map.size).toBe(0);
  vi.stubGlobal('location', { hash: '', pathname: '/family-invite' }); expect(landFamilyInvite()).toBe('INCOMPLETE');
});

it('says so when the browser cannot keep the invitation, and never throws on blocked storage', () => {
  vi.stubGlobal('history', { replaceState: vi.fn() });
  vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } });
  vi.stubGlobal('location', { hash: `#i=${id(1)}&c=${token}`, pathname: '/family-invite' });
  expect(landFamilyInvite()).toBe('STORAGE');
  expect(keepFamilyInvite({ invitationId: id(1), token })).toBe(false); expect(readFamilyInvite()).toBeNull(); expect(() => dropFamilyInvite()).not.toThrow();
});

it('the email command sends only the school, invitation, code and language, as a same-origin human command', async () => {
  const fetcher = vi.fn(async () => json({ data: { invitationId: id(1), email: 'dana@example.com', emailNumber: 1, delivery: 'SENT' } })); vi.stubGlobal('fetch', fetcher);
  const receipt = await familyInviteApi.email({ schoolId: id(2), invitationId: id(1), token, language: 'en' }, id(9));
  expect(receipt.delivery).toBe('SENT');
  const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/school/family-access-invitations/email');
  expect(JSON.parse(String(init.body))).toEqual({ schoolId: id(2), invitationId: id(1), token, language: 'en' });
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'school-family-account', 'Idempotency-Key': id(9) });
  expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', referrerPolicy: 'no-referrer' });
  expect(() => validateFamilyInvitationEmailInput({ schoolId: id(2), invitationId: id(1), token, language: 'en', email: 'x@example.com' })).toThrow();
  expect(() => validateFamilyInvitationEmailInput({ schoolId: id(2), invitationId: id(1), token, language: 'fr' })).toThrow();
  expect(() => validateFamilyInvitationEmailReceipt({ invitationId: id(1), email: 'dana@example.com', emailNumber: 4, delivery: 'SENT' })).toThrow();
});

it('each refusal of the email command becomes one plain outcome for the staff member', async () => {
  const cases: [Response | Error, string, string][] = [
    [json({ code: 'ACCOUNT_EMAIL_OFF', outcome: 'NOT_SUBMITTED' }, 503), 'OFF', 'OFF'], [json({ code: 'ACCOUNT_EMAIL_LIMIT' }, 429), 'LIMIT', 'LIMIT'],
    [json({ code: 'ACCOUNT_RATE_LIMITED' }, 429), 'WAIT', 'WAIT'], [json({ code: 'ACCOUNT_FORBIDDEN' }, 403), 'DENIED', 'DENIED'], [json({}, 401), 'SESSION', 'DENIED'],
    [json({ code: 'ACCOUNT_UNAVAILABLE' }, 404), 'GONE', 'NOT_SENT'], [json({ code: 'ACCOUNT_INPUT_INVALID' }, 400), 'REJECTED', 'NOT_SENT'],
    [json({ code: 'ACCOUNT_UNAVAILABLE' }, 503), 'UNKNOWN', 'UNKNOWN'], [new Error('offline'), 'UNKNOWN', 'UNKNOWN'], [json({ nope: true }), 'UNKNOWN', 'UNKNOWN'],
  ];
  for (const [answer, kind, mail] of cases) {
    vi.stubGlobal('fetch', vi.fn(async () => { if (answer instanceof Error) throw answer; return answer.clone(); }));
    const error = await familyInviteApi.email({ schoolId: id(2), invitationId: id(1), token, language: 'ko' }, id(9)).catch(e => e);
    expect(error).toBeInstanceOf(FamilyInviteError); expect((error as FamilyInviteError).kind).toBe(kind); expect(mailAfterError(error)).toBe(mail);
  }
  expect(mailAfterError(new Error('x'))).toBe('UNKNOWN');
});

it('activation sends the kept invitation with the fixed confirmation and reads the receipt', async () => {
  const receipt = { invitationId: id(1), schoolId: id(2), familyId: id(3), accessLevel: 'PRIMARY_GUARDIAN', accountStatus: 'FAMILY_ACCESS_BOUND', accessGranted: false, billingActivated: false, aiCreditsGranted: false };
  const fetcher = vi.fn(async () => json({ data: receipt })); vi.stubGlobal('fetch', fetcher);
  expect(await familyInviteApi.activate(id(1), token, id(9))).toMatchObject({ accountStatus: 'FAMILY_ACCESS_BOUND' });
  const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/account/family-access-invitations/accept');
  expect(JSON.parse(String(init.body))).toEqual({ invitationId: id(1), token, confirmation: 'ACCEPT_FAMILY_ACCESS_INVITATION' });
  for (const [answer, kind] of [[json({ code: 'ACCOUNT_FORBIDDEN' }, 403), 'DENIED'], [json({ code: 'VERIFIED_EMAIL_REQUIRED' }, 403), 'VERIFY'], [json({ code: 'ACCOUNT_REVIEW_REQUIRED' }, 409), 'REVIEW'],
    [json({ code: 'ACCOUNT_CONFLICT' }, 409), 'REJECTED'], [json({}, 401), 'SESSION'], [json({}, 500), 'UNKNOWN']] as const) {
    vi.stubGlobal('fetch', vi.fn(async () => answer.clone()));
    await expect(familyInviteApi.activate(id(1), other, id(9))).rejects.toMatchObject({ kind });
  }
  await expect(familyInviteApi.activate('x', token, id(9))).rejects.toThrow();
});

it('the pages render without the invitation, the code or any address in their first paint', () => {
  const landing = renderToStaticMarkup(<FamilyInviteLanding go={() => undefined}/>);
  expect(landing).toContain('Family app invitation'); expect(landing).toContain('Opening your invitation');
  const page = renderToStaticMarkup(<FamilyInviteActivate sessionEmail="dana@example.com" fallback={<p>ID and code page</p>} read={() => ({ invitationId: id(1), token })}/>);
  expect(page).toContain('Family app invitation'); expect(page).not.toContain(token); expect(page).not.toContain(id(1)); expect(page).not.toContain('ID and code page');
});

it('wording exists in English, Korean and Spanish for the parent and the staff member', () => {
  expect(familyInviteText('en', 'done', { email: 'dana@example.com' })).toContain('sign in with dana@example.com');
  expect(familyInviteText('en', 'DENIED', { email: 'dana@example.com' })).toContain('different email address');
  for (const language of ['ko', 'es']) {
    expect(familyInviteText(language, 'activate')).not.toBe(familyInviteText('en', 'activate'));
    expect(panelText(language, 'accessMailInvite')).not.toBe(panelText('en', 'accessMailInvite'));
  }
  expect(panelText('en', 'accessMailSent', { email: 'dana@example.com' })).toContain('Invitation emailed to dana@example.com');
  expect(familyInviteText('fr', 'activate')).toBe(familyInviteText('en', 'activate'));
});
