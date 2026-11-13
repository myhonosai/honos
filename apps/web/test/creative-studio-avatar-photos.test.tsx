import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CREATIVE_PHOTO_AVATAR_DESCRIPTION, type CreativeAvatar, type CreativeGeneration, type CreativePhotoAvatarInput, type CreativePhotoConsent,
  type CreativePhotoUploadInput } from '@hon/contracts';
import { CreativeGenerationError, createCreativePhotoAvatar, deleteCreativeAvatarPhoto, listCreativeAvatarPhotos, prepareCreativePhotoUpload, readCreativeAvatarPhotoImage,
  uploadCreativeAvatarPhoto } from '../src/components/creative-studio/generation-http';
import { matchesPendingPhotoAvatar, photoSaveOutcome } from '../src/components/creative-studio/creative-studio';
import { fileBase64 } from '../src/components/creative-studio/avatar-photos';
import { studioWallet, type AvatarsState, type CreateOutcome, type PhotoOutcome, type PhotosState } from '../src/components/creative-studio/model';
import { CreativeStudioView } from '../src/components/creative-studio/view';
import { id, rawWallet, reply, scope } from './account-status-fixtures';

// A3 Creative Studio photo avatars (0305): an adult staff member's OWN photo, signed likeness consent, delete at any time.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const photo = btoa(String.fromCharCode(0xff, 0xd8, ...new Array(126).fill(7), 0xff, 0xd9));
const upload: CreativePhotoUploadInput = { consentVersion: 'HON-LIKENESS-2026-11-12', ownLikeness: true, adult: true, marketingUse: true, signatureName: 'Dana Kim',
  contentType: 'image/jpeg', photo };
const consentId = id(990), key = id(991);
function consent(extra: Partial<CreativePhotoConsent> = {}): CreativePhotoConsent {
  return { consentId, schoolId: scope.schoolId, mine: true, signatureName: 'Dana Kim', consentVersion: 'HON-LIKENESS-2026-11-12', contentType: 'image/jpeg', byteSize: 128,
    status: 'ACTIVE', withdrawnReason: null, withdrawnAt: null, avatarIds: [], createdAt: '2026-11-12T08:00:00.000Z', ...extra };
}
const withdrawn = (extra: Partial<CreativePhotoConsent> = {}) => consent({ status: 'WITHDRAWN', withdrawnReason: 'DELETED_BY_SUBJECT', withdrawnAt: '2026-11-12T09:00:00.000Z', ...extra });
function avatar(extra: Partial<CreativeAvatar> = {}): CreativeAvatar {
  const g: CreativeGeneration = { generationId: id(964), schoolId: scope.schoolId, operationCode: 'avatar.create', mediaKind: 'IMAGE', units: 1, format: 'PORTRAIT',
    prompt: CREATIVE_PHOTO_AVATAR_DESCRIPTION, status: 'SUCCEEDED', failureReason: null, reservedCredits: 100, chargedCredits: 100,
    createdAt: '2026-11-12T05:00:00.000Z', completedAt: '2026-11-12T05:00:05.000Z',
    assets: [{ assetId: id(963), ordinal: 1, mediaType: 'image/png', width: 1024, height: 1024, durationSeconds: null, origin: 'SYNTHETIC' }] };
  return { avatarId: id(970), schoolId: scope.schoolId, name: 'Coach Dana', style: 'REALISTIC', description: CREATIVE_PHOTO_AVATAR_DESCRIPTION, status: 'READY',
    createdAt: g.createdAt, generation: g, ...extra };
}
const signal = () => new AbortController().signal;
const base = `/api/v1/schools/${scope.schoolId}/creative-studio/avatar-photos`;

it('lists photos with a fixed same-origin GET, refuses another school, and reads only the asked-for image', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply({ photos: [consent()], canManageAll: false, limit: 50 }));
  expect((await listCreativeAvatarPhotos(scope.schoolId, signal())).photos).toHaveLength(1);
  const [path, init] = f.mock.calls[0]!;
  expect(path).toBe(base);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
  f.mockResolvedValue(reply({ photos: [consent({ schoolId: id(9) })], canManageAll: false, limit: 50 }));
  await expect(listCreativeAvatarPhotos(scope.schoolId, signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
  // A non-owner must never be shown somebody else's consent.
  f.mockResolvedValue(reply({ photos: [consent({ mine: false })], canManageAll: false, limit: 50 }));
  await expect(listCreativeAvatarPhotos(scope.schoolId, signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
  f.mockResolvedValue(reply({}, 403));
  await expect(listCreativeAvatarPhotos(scope.schoolId, signal())).rejects.toMatchObject({ kind: 'DENIED' });
  f.mockResolvedValue(reply({ consentId, contentType: 'image/jpeg', photo }));
  expect((await readCreativeAvatarPhotoImage(scope.schoolId, consentId, signal())).photo).toBe(photo);
  expect(f.mock.calls.at(-1)![0]).toBe(`${base}/${consentId}/image`);
  f.mockResolvedValue(reply({ consentId: id(1), contentType: 'image/jpeg', photo }));
  await expect(readCreativeAvatarPhotoImage(scope.schoolId, consentId, signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
});

it('saves with exactly the signed consent, the upload command and the key; an incomplete consent is never sent', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply({ photo: consent(), replayed: false }));
  expect((await uploadCreativeAvatarPhoto(scope.schoolId, upload, key, signal())).photo.status).toBe('ACTIVE');
  const [path, init] = f.mock.calls[0]!;
  expect(path).toBe(base);
  expect((init as RequestInit).headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'saas-creative-avatar-photo-upload', 'Idempotency-Key': key });
  expect(JSON.parse(String((init as RequestInit).body))).toEqual(upload);
  f.mockClear();
  for (const bad of [{ ...upload, ownLikeness: false }, { ...upload, adult: false }, { ...upload, marketingUse: false }, { ...upload, signatureName: 'D' },
    { ...upload, signatureName: ' Dana' }, { ...upload, contentType: 'image/gif' }, { ...upload, photo: 'not base64!' }, { ...upload, photo: btoa('tiny') },
    { ...upload, consentVersion: 'OLD' }, { ...upload, subjectId: id(5) }]) {
    expect(() => prepareCreativePhotoUpload(bad as CreativePhotoUploadInput)).toThrow(CreativeGenerationError);
    await expect(uploadCreativeAvatarPhoto(scope.schoolId, bad as CreativePhotoUploadInput, key, signal())).rejects.toMatchObject({ kind: 'INVALID' });
  }
  expect(f).not.toHaveBeenCalled();
  const cases: [number, string | null, string][] = [[400, 'INVALID_SAAS_INPUT', 'INVALID'], [404, 'SAAS_UNAVAILABLE', 'INVALID'], [409, 'IDEMPOTENCY_KEY_REUSED', 'INVALID'],
    [409, 'SAAS_TRANSITION_NOT_ALLOWED', 'UNKNOWN'], [403, 'SAAS_FORBIDDEN', 'DENIED'], [500, null, 'UNKNOWN']];
  for (const [status, code, kind] of cases) {
    f.mockResolvedValueOnce(Response.json(code ? { code } : {}, { status }));
    await expect(uploadCreativeAvatarPhoto(scope.schoolId, upload, key, signal()), `${status} ${code}`).rejects.toMatchObject({ kind });
  }
  f.mockRejectedValueOnce(new TypeError('network'));
  await expect(uploadCreativeAvatarPhoto(scope.schoolId, upload, key, signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
  f.mockResolvedValueOnce(reply({ photo: consent({ signatureName: 'Someone Else' }), replayed: false }));
  await expect(uploadCreativeAvatarPhoto(scope.schoolId, upload, key, signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
  expect(photoSaveOutcome(new CreativeGenerationError('INVALID'))).toEqual({ outcome: { kind: 'SAVE_INVALID' }, release: true });
  expect(photoSaveOutcome(new CreativeGenerationError('DENIED'))).toEqual({ outcome: { kind: 'DENIED' }, release: true });
  expect(photoSaveOutcome(new CreativeGenerationError('UNKNOWN'))).toEqual({ outcome: { kind: 'SAVE_UNKNOWN' }, release: false });
  expect(photoSaveOutcome(new TypeError('x'))).toEqual({ outcome: { kind: 'SAVE_UNKNOWN' }, release: false });
});

it('deletes with an empty body and the delete command; only a withdrawn answer for that photo counts', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply({ photo: withdrawn() }));
  expect((await deleteCreativeAvatarPhoto(scope.schoolId, consentId, signal())).photo.status).toBe('WITHDRAWN');
  const [path, init] = f.mock.calls[0]!;
  expect(path).toBe(`${base}/${consentId}/delete`);
  expect((init as RequestInit).headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'saas-creative-avatar-photo-delete' });
  expect((init as RequestInit).body).toBe('{}');
  f.mockResolvedValueOnce(reply({ photo: consent() }));
  await expect(deleteCreativeAvatarPhoto(scope.schoolId, consentId, signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
  f.mockResolvedValueOnce(reply({ photo: withdrawn({ consentId: id(1) }) }));
  await expect(deleteCreativeAvatarPhoto(scope.schoolId, consentId, signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
  f.mockResolvedValueOnce(Response.json({ code: 'SAAS_UNAVAILABLE' }, { status: 404 }));
  await expect(deleteCreativeAvatarPhoto(scope.schoolId, consentId, signal())).rejects.toMatchObject({ kind: 'INVALID' });
  f.mockResolvedValueOnce(Response.json({}, { status: 502 }));
  await expect(deleteCreativeAvatarPhoto(scope.schoolId, consentId, signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
});

it('makes a photo avatar with the closed request and maps a deleted photo as a definitive refusal', async () => {
  const input: CreativePhotoAvatarInput = { consentId, name: 'Coach Dana', style: 'REALISTIC' };
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply({ avatar: avatar(), balance: rawWallet().balance, replayed: false }));
  expect((await createCreativePhotoAvatar(scope.schoolId, input, key, signal())).avatar.status).toBe('READY');
  const [path, init] = f.mock.calls[0]!;
  expect(path).toBe(`${base}/avatars`);
  expect((init as RequestInit).headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'saas-creative-photo-avatar-create', 'Idempotency-Key': key });
  expect(JSON.parse(String((init as RequestInit).body))).toEqual(input);
  f.mockClear();
  for (const bad of [{ ...input, consentId: 'x' }, { ...input, name: '' }, { ...input, style: 'ANIME' }, { ...input, description: 'someone else' }]) {
    await expect(createCreativePhotoAvatar(scope.schoolId, bad as CreativePhotoAvatarInput, key, signal())).rejects.toMatchObject({ kind: 'INVALID' });
  }
  expect(f).not.toHaveBeenCalled();
  const cases: [number, string | null, string][] = [[422, 'CREATIVE_AVATAR_WITHDRAWN', 'REFUSED'], [422, 'CREATIVE_AVATAR_LIMIT_REACHED', 'REFUSED'],
    [422, 'SAAS_OPERATION_NOT_PRICED', 'REFUSED'], [422, 'SAAS_CREATIVE_LEDGER_MISMATCH', 'UNKNOWN'], [503, 'CREATIVE_PROVIDER_NOT_CONNECTED', 'NOT_CONNECTED'],
    [404, 'SAAS_UNAVAILABLE', 'INVALID'], [409, 'IDEMPOTENCY_KEY_REUSED', 'INVALID'], [403, 'SAAS_FORBIDDEN', 'DENIED'], [500, null, 'UNKNOWN']];
  for (const [status, code, kind] of cases) {
    f.mockResolvedValueOnce(Response.json(code ? { code } : {}, { status }));
    await expect(createCreativePhotoAvatar(scope.schoolId, input, key, signal()), `${status} ${code}`).rejects.toMatchObject({ kind });
  }
  f.mockResolvedValueOnce(reply({ avatar: avatar({ description: 'A described look' }), balance: rawWallet().balance, replayed: false }));
  await expect(createCreativePhotoAvatar(scope.schoolId, input, key, signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
  expect(matchesPendingPhotoAvatar({ input }, avatar())).toBe(true);
  expect(matchesPendingPhotoAvatar({ input }, avatar({ description: 'A described look' }))).toBe(false);
  expect(matchesPendingPhotoAvatar(null, avatar())).toBe(false);
});

it('reads a file as canonical base64 in chunks', async () => {
  const bytes = new Uint8Array(70000).map((_, i) => i % 251);
  const text = await fileBase64(new Blob([bytes]));
  expect(Buffer.from(text, 'base64').equals(Buffer.from(bytes))).toBe(true);
});

function wallet(withRate = true) {
  const raw = rawWallet();
  return studioWallet({ ...raw, walletVersion: 2, program: { ...raw.program, status: 'ACTIVE' }, eligibility: { eligible: true, reason: null, window: null },
    balance: { availableCredits: 1000, heldCredits: 0, byKind: raw.balance.byKind.map(k => k.kind === 'INCLUDED_MONTHLY' ? { ...k, grantedCredits: 1000, availableCredits: 1000 } : k) },
    rates: { rateVersionId: id(40), rateVersion: 1, termsReference: 'terms', publishedAt: '2026-11-01T00:00:00.000Z', rates: withRate ? [
      { operationCode: 'avatar.create', mediaKind: 'IMAGE', displayName: 'AI avatar', billingUnit: 'REQUEST', creditsPerUnit: 100, maxUnitsPerRequest: 1, rateBasis: 'PROVISIONAL' }] : [] } });
}
const connected: AvatarsState = { state: 'READY', provider: 'CONNECTED', items: [] };
const view = (photos: PhotosState, extra: { avatars?: AvatarsState; language?: string; w?: ReturnType<typeof wallet>; image?: string | null; outcome?: PhotoOutcome;
  avatarOutcome?: CreateOutcome; saveLocked?: boolean } = {}) => renderToStaticMarkup(
  <CreativeStudioView language={extra.language ?? 'en'} waiting={false} concealed={false} hasSchool studio={{ state: 'READY', wallet: extra.w ?? wallet() }}
    generations={{ state: 'READY', provider: 'CONNECTED', items: [] }} avatars={extra.avatars ?? connected} photos={photos} photoImage={extra.image ?? null}
    photoOutcome={extra.outcome ?? null} photoAvatarOutcome={extra.avatarOutcome ?? null} photoSaveLocked={extra.saveLocked}
    onSavePhoto={() => {}} onCheckPhotoSave={() => {}} onDeletePhoto={() => {}} onCreatePhotoAvatar={() => {}} onCheckPhotoAvatarAgain={() => {}}/>);
const card = (html: string) => html.slice(html.indexOf('creative-avatar-photos-title') - 60, html.indexOf('creative-avatar-videos-title'));
const none: PhotosState = { state: 'READY', items: [], canManageAll: false };

it('offers saving a photo only when avatars are open, with all three consents and a typed name required', () => {
  const off = card(view(none, { avatars: { state: 'READY', provider: 'NOT_CONNECTED', items: [] } }));
  expect(off).toContain('data-avatar-photo-state="NOT_CONNECTED"'); expect(off).toContain('Photo avatars are not connected yet'); expect(off).not.toMatch(/type="file"/);
  expect(card(view(none, { w: wallet(false) }))).toContain('data-avatar-photo-state="NOT_PRICED"');
  const open = card(view(none));
  expect(open).toContain('data-avatar-photo-state="OPEN"'); expect(open).toContain('Use my photo');
  expect(open).toMatch(/type="file" accept="image\/jpeg,image\/png,image\/webp"/);
  expect(open.match(/type="checkbox"/g)).toHaveLength(3);
  expect(open).toContain('This is a photo of me, and nobody else is in it.'); expect(open).toContain('I am an adult (18 or older)');
  expect(open).toContain('Never use a photo of a student, a child or anyone else.'); expect(open).toContain('Type your full name to sign');
  expect(open).toMatch(/<button type="submit" disabled="">Sign and save my photo<\/button>/);
  expect(card(view(none, { saveLocked: true }))).toMatch(/type="file"[^>]*disabled=""/);
  const unknown = card(view(none, { outcome: { kind: 'SAVE_UNKNOWN' } }));
  expect(unknown).toContain('it is never saved twice'); expect(unknown).toContain('Check again');
});

it('shows my own photo with Make my avatar and a two-step delete, and the owner sees staff consents but never their photos', () => {
  const mine = card(view({ state: 'READY', items: [consent({ avatarIds: [id(970)] })], canManageAll: false }, { image: `data:image/jpeg;base64,${photo}` }));
  expect(mine).toContain('data-photo-mine'); expect(mine).toContain(`src="data:image/jpeg;base64,${photo}"`);
  expect(mine).toContain('Signed by Dana Kim on'); expect(mine).toContain('Avatars made from it: 1');
  expect(mine).toContain('Make my avatar'); expect(mine).toContain('Uses 100 credits. You have 1,000 available.');
  expect(mine).toContain('Delete my photo'); expect(mine).not.toContain('Yes, delete it'); expect(mine).not.toMatch(/type="file"/);
  // Deleting is still offered when avatars are not connected; making one is not.
  const offline = card(view({ state: 'READY', items: [consent()], canManageAll: false }, { avatars: { state: 'READY', provider: 'NOT_CONNECTED', items: [] } }));
  expect(offline).toContain('Delete my photo'); expect(offline).not.toContain('Make my avatar');
  const owner = card(view({ state: 'READY', items: [consent({ consentId: id(992), mine: false, signatureName: 'Sam Lee' }),
    withdrawn({ consentId: id(993), mine: false, signatureName: 'Ana Ruiz', withdrawnReason: 'DELETED_BY_OWNER' })], canManageAll: true }));
  expect(owner).toContain('Staff photos'); expect(owner).toContain('You never see the photos themselves.');
  expect(owner).toContain('Delete Sam Lee’s photo'); expect(owner).not.toContain('Delete Ana Ruiz’s photo'); expect(owner).toContain('Deleted');
  expect(owner).not.toMatch(/<img/);
  expect(card(view(none, { outcome: { kind: 'DELETED' } }))).toContain('Its avatars and videos are withdrawn.');
  expect(card(view({ state: 'READY', items: [consent()], canManageAll: false }, { avatarOutcome: { kind: 'REFUSED', code: 'CREATIVE_AVATAR_WITHDRAWN' } })))
    .toContain('that photo was deleted or is no longer active');
});

it('speaks Korean and Spanish, and shows nothing private while concealed', () => {
  const ko = card(view(none, { language: 'ko' }));
  expect(ko).toContain('내 사진 사용'); expect(ko).toContain('서명하고 사진 저장'); expect(ko).toContain('이 사진은 제 사진이며');
  const es = card(view({ state: 'READY', items: [consent()], canManageAll: false }, { language: 'es' }));
  expect(es).toContain('Usar mi foto'); expect(es).toContain('Borrar mi foto'); expect(es).toContain('Crear mi avatar');
  const hidden = renderToStaticMarkup(<CreativeStudioView language="en" waiting={false} concealed hasSchool studio={{ state: 'READY', wallet: wallet() }}
    avatars={connected} photos={{ state: 'READY', items: [consent()], canManageAll: false }} photoImage={`data:image/jpeg;base64,${photo}`} photoOutcome={{ kind: 'SAVE_UNKNOWN' }}/>);
  expect(hidden).not.toContain('Dana Kim'); expect(hidden).not.toMatch(/<img|type="file"/); expect(hidden).not.toContain('Check again');
});
