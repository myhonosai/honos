import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AddContact, saveAfterError, watchContactHold } from '../src/components/people/add-contact';
import { addContactText } from '../src/components/people/add-contact-copy';
import { AddContactError, addContactApi, buildContactPlan, prepareContact, type ContactForm } from '../src/components/people/add-contact-http';
import { PeopleView, type PeopleViewProps } from '../src/components/people/view';
import { NO_CONTACT_FILTERS } from '../src/components/people/contacts-http';
import { id, scope } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' };
const json = (body: unknown, status = 201) => new Response(JSON.stringify(body), { status, headers });
const stub = (...responses: Response[]) => { const f = vi.fn(async () => responses.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const made = (n: number, status = 201) => json({ data: { id: id(n) }, meta: { requestId: id(5), correlationId: id(5), replayed: status === 200 } }, status);
const form = (over: Partial<ContactForm> = {}): ContactForm => ({ kind: 'FAMILY', givenName: ' Dana ', familyName: 'Lee', email: 'Dana@Example.com', phone: '(555) 555-0100',
  childGivenName: 'Mia', childFamilyName: '', adultStudent: true, consent: true, ...over });
let n = 0;
const keys = () => id(200 + ++n);
const capsule = (over: Partial<ContactForm> = {}) => { const f = form(over); const built = buildContactPlan(f); if (!built.ok) throw new Error(built.problem); return prepareContact(scope, built.plan, f, keys); };
const base = `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}`;
const sent = (f: ReturnType<typeof stub>) => (f.mock.calls as unknown as [string, RequestInit][]).map(([path, init]) => ({ path, key: (init.headers as Record<string, string>)['Idempotency-Key'], body: JSON.parse(String(init.body)) as Record<string, unknown>, init }));

it('a parent and child become two people, one family and two family links; the child has no address and no consent record', () => {
  const built = buildContactPlan(form());
  expect(built).toEqual({ ok: true, plan: {
    adult: { givenName: 'Dana', familyName: 'Lee', email: 'dana@example.com', phoneE164: '+15555550100' },
    child: { givenName: 'Mia', familyName: 'Lee', consentChannels: [] }, familyName: 'Lee family', adultRole: 'GUARDIAN', label: 'Dana Lee' } });
  expect(buildContactPlan(form({ consent: false, childFamilyName: 'Park' }))).toMatchObject({ plan: { adult: { consentChannels: [] }, child: { familyName: 'Park' } } });
});

it('one adult is a single person, or a student with their own family record when ticked', () => {
  expect(buildContactPlan(form({ kind: 'ADULT', adultStudent: false, email: '', phone: '' })))
    .toEqual({ ok: true, plan: { adult: { givenName: 'Dana', familyName: 'Lee' }, child: null, familyName: null, adultRole: null, label: 'Dana Lee' } });
  expect(buildContactPlan(form({ kind: 'ADULT' }))).toMatchObject({ plan: { child: null, familyName: 'Lee family', adultRole: 'STUDENT' } });
});

it('refuses a missing name, a bad address and a bad number before anything is sent', () => {
  expect(buildContactPlan(form({ givenName: ' ' }))).toEqual({ ok: false, problem: 'nameMissing' });
  expect(buildContactPlan(form({ childGivenName: '' }))).toEqual({ ok: false, problem: 'childNameMissing' });
  expect(buildContactPlan(form({ email: 'nope' }))).toEqual({ ok: false, problem: 'emailInvalid' });
  expect(buildContactPlan(form({ phone: '12' }))).toEqual({ ok: false, problem: 'phoneInvalid' });
  const built = buildContactPlan(form()); if (!built.ok) throw new Error(built.problem);
  expect(() => prepareContact({ organizationId: 'x', schoolId: scope.schoolId }, built.plan, form(), keys)).toThrow();
  expect(() => prepareContact(scope, built.plan, form(), () => id(1))).toThrow();
});

it('sends the five existing commands in order, same-origin, each with its own key', async () => {
  const f = stub(made(11), made(12), made(13), made(14), made(15));
  const c = capsule();
  await expect(addContactApi.add(c)).resolves.toEqual({ adultId: id(11), childId: id(12), familyId: id(13) });
  const calls = sent(f);
  expect(calls.map(x => x.path)).toEqual([`${base}/people`, `${base}/people`, `${base}/families`, `${base}/families/${id(13)}/members`, `${base}/families/${id(13)}/members`]);
  expect(calls.map(x => x.key)).toEqual([c.keys.adult, c.keys.child, c.keys.family, c.keys.adultMember, c.keys.childMember]);
  expect(calls.map(x => x.body)).toEqual([c.plan.adult, c.plan.child, { displayName: 'Lee family' },
    { personId: id(11), memberRole: 'GUARDIAN' }, { personId: id(12), memberRole: 'STUDENT' }]);
  for (const x of calls) expect(x.init).toMatchObject({ method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
});

it('one adult who is not a student sends one command only', async () => {
  const f = stub(made(11));
  await expect(addContactApi.add(capsule({ kind: 'ADULT', adultStudent: false }))).resolves.toEqual({ adultId: id(11), childId: null, familyId: null });
  expect(f).toHaveBeenCalledTimes(1);
});

it('a lost answer stops the run; trying again replays the same steps with the same keys', async () => {
  const c = capsule();
  let f = stub(made(11), made(12), json({}, 502));
  await expect(addContactApi.add(c)).rejects.toMatchObject({ kind: 'UNKNOWN', step: 'family' });
  expect(f).toHaveBeenCalledTimes(3);
  f = stub(made(11, 200), made(12, 200), made(13), made(14), made(15));
  await expect(addContactApi.add(c)).resolves.toMatchObject({ familyId: id(13) });
  expect(sent(f).map(x => x.key)).toEqual([c.keys.adult, c.keys.child, c.keys.family, c.keys.adultMember, c.keys.childMember]);
});

it('names the step that was refused, and treats "still processing" and unreadable answers as unknown', async () => {
  for (const [responses, expected] of [
    [[json({}, 403)], { kind: 'DENIED', step: 'adult' }], [[json({}, 400)], { kind: 'REJECTED', step: 'adult' }],
    [[made(11), made(12), json({}, 403)], { kind: 'DENIED', step: 'family' }],
    [[made(11), made(12), made(13), made(14), json({ code: 'FAMILY_MEMBER_EXISTS' }, 409)], { kind: 'REJECTED', step: 'childMember' }],
    [[json({ code: 'IDEMPOTENCY_IN_PROGRESS' }, 409)], { kind: 'UNKNOWN', step: 'adult' }],
    [[json({ data: { id: 'nope' }, meta: {} })], { kind: 'UNKNOWN', step: 'adult' }],
    [[new Response('ok', { status: 201 })], { kind: 'UNKNOWN', step: 'adult' }],
  ] as const) {
    stub(...responses.map(r => r.clone()));
    await expect(addContactApi.add(capsule())).rejects.toMatchObject(expected);
  }
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
  await expect(addContactApi.add(capsule())).rejects.toMatchObject({ kind: 'UNKNOWN', step: 'adult' });
});

it('a lost session is reported once, and only while this form still owns the request', async () => {
  const seen = vi.fn(); window.addEventListener('hon:session-invalidated', seen);
  stub(json({}, 401)); await expect(addContactApi.add(capsule(), () => false)).rejects.toMatchObject({ kind: 'SESSION' });
  expect(seen).not.toHaveBeenCalled();
});

it('after the adult is saved, a later refusal is shown as partly saved and keeps the same request', () => {
  expect(saveAfterError(new AddContactError('REJECTED', 'adult'), 'Dana Lee')).toEqual({ state: 'REJECTED' });
  expect(saveAfterError(new AddContactError('DENIED', 'adult'), 'Dana Lee')).toEqual({ state: 'DENIED' });
  expect(saveAfterError(new AddContactError('DENIED', 'family'), 'Dana Lee')).toEqual({ state: 'PARTIAL', name: 'Dana Lee', denied: true });
  expect(saveAfterError(new AddContactError('REJECTED', 'childMember'), 'Dana Lee')).toEqual({ state: 'PARTIAL', name: 'Dana Lee', denied: false });
  expect(saveAfterError(new AddContactError('UNKNOWN', 'child'), 'Dana Lee')).toEqual({ state: 'UNCERTAIN' });
  expect(saveAfterError(new Error('x'), 'Dana Lee')).toEqual({ state: 'UNCERTAIN' });
});

it('shows one Add contact button, and the open form asks for the parent and the child', () => {
  const closed = renderToStaticMarkup(<AddContact scope={scope} language="en"/>);
  expect(closed).toContain('Add contact'); expect(closed).not.toContain('<form');
  const open = renderToStaticMarkup(<AddContact scope={scope} language="en" initialOpen/>);
  for (const text of ['Add a contact', 'A parent and their child', 'One adult', 'Parent or guardian', 'Child first name', 'Record email and text consent']) expect(open).toContain(text);
  expect(open).not.toContain('This adult is a student');
  for (const language of ['ko', 'es']) expect(addContactText(language, 'button')).not.toBe(addContactText('en', 'button'));
  expect(addContactText('en', 'saved', { name: 'Dana Lee' })).toContain('Dana Lee was added');
});

it('a request kept by the page comes back locked on the same request, never as an empty form', () => {
  const hold = { current: capsule() };
  const back = renderToStaticMarkup(<AddContact scope={scope} language="en" hold={hold}/>);
  for (const text of ['<form', 'Try again', 'Start over', 'We could not confirm everything was saved']) expect(back).toContain(text);
  expect(back).toContain(`value="${hold.current.form.givenName}"`); expect(back).not.toContain('>Adding…<');
  const other = renderToStaticMarkup(<AddContact scope={{ ...scope, schoolId: id(77) }} language="en" hold={hold}/>);
  expect(other).not.toContain('<form');
});

it('a kept request is dropped when the session ends or the school changes, so the next person gets an empty form', () => {
  for (const event of ['hon:session-invalidated', 'hon:school-context-changed']) {
    const hold = { current: capsule() as ReturnType<typeof capsule> | null };
    const stop = watchContactHold(hold);
    window.dispatchEvent(new Event('blur')); expect(hold.current).not.toBeNull();
    window.dispatchEvent(new Event(event)); expect(hold.current).toBeNull();
    const next = renderToStaticMarkup(<AddContact scope={scope} language="en" hold={hold}/>);
    expect(next).not.toContain('<form'); expect(next).not.toContain('Dana');
    stop(); hold.current = capsule(); window.dispatchEvent(new Event(event)); expect(hold.current).not.toBeNull();
  }
});

it('Contacts shows the button only once the school is verified', () => {
  const props: PeopleViewProps = { language: 'en', waiting: false, concealed: false, hasSchool: true, list: { state: 'LOADING' }, record: { state: 'NONE' }, selectedId: null,
    outcome: null, locked: false, canRetry: false, filters: NO_CONTACT_FILTERS, options: null, addSlot: <button type="button">Add contact</button> } as unknown as PeopleViewProps;
  expect(renderToStaticMarkup(<PeopleView {...props}/>)).toContain('Add contact');
  for (const hidden of [{ waiting: true }, { concealed: true }, { hasSchool: false }]) expect(renderToStaticMarkup(<PeopleView {...props} {...hidden}/>)).not.toContain('Add contact');
});

it('the invitation suggests the open contact email only when that person is a guardian of the family shown', async () => {
  const { guardianEmail } = await import('../src/components/people/people');
  const family = { familyId: id(30), name: 'Lee family', members: [{ personId: id(11), givenName: 'Dana', familyName: 'Lee', role: 'GUARDIAN', billingContact: false },
    { personId: id(12), givenName: 'Mia', familyName: 'Lee', role: 'STUDENT', billingContact: false }] } as never;
  const card = (personId: string, email: string | null) => ({ state: 'READY', card: { person: { personId, email } } }) as never;
  expect(guardianEmail(card(id(11), 'dana@example.com'), family)).toBe('dana@example.com');
  expect(guardianEmail(card(id(12), 'mia@example.com'), family)).toBeNull();
  expect(guardianEmail(card(id(99), 'x@example.com'), family)).toBeNull();
  expect(guardianEmail({ state: 'LOADING' } as never, family)).toBeNull();
});
