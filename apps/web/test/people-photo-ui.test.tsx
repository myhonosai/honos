import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PhotoError, keepPhotoForRetry, photoApi, photoErrorFor, photoSize } from '../src/components/people/photo-http';
import { PhotoCard, initialsOf, photoText, type PhotoCardProps } from '../src/components/people/photo';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
import { id } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const school = id(2), person = id(30), key = id(77), scope = { schoolId: school };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as PhotoError; } throw new Error('expected a failure'); };
const DATA = '/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==';
const photo = { mediaType: 'image/jpeg', data: DATA, checksum: 'a'.repeat(64), version: 2, updatedAt: '2026-11-16T03:00:00.000Z' };
const summary = (version: number) => ({ personId: person, mediaType: 'image/jpeg', bytes: 22, checksum: 'b'.repeat(64), version, updatedAt: '2026-11-16T03:00:00.000Z' });

it('reads the photo as a plain same-origin GET with no key or command header, and refuses another person', async () => {
  const f = stub(json({ data: { personId: person, photo } }));
  expect((await photoApi.read(scope, person.toUpperCase(), signal(), () => true)).photo?.version).toBe(2);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/school/schools/${school}/people/${person}/photo`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  stub(json({ data: { personId: id(31), photo } }));
  expect((await fails(photoApi.read(scope, person, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: { personId: person, photo: { ...photo, extra: 1 } } }));
  expect((await fails(photoApi.read(scope, person, signal(), () => true))).kind).toBe('UNKNOWN');
});

it('sends set and remove as one closed body with the photo command and the key, and checks the saved version', async () => {
  const f = stub(json({ data: { photo: summary(1), replaced: false, replayed: false } }));
  expect((await photoApi.set(scope, person, null, 'image/jpeg', DATA, key, signal(), () => true)).photo.version).toBe(1);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/school/people/photo');
  expect(init.method).toBe('POST');
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'school-person-photo', 'Idempotency-Key': key, 'Content-Type': 'application/json' });
  expect(JSON.parse(String(init.body))).toEqual({ schoolId: school, personId: person, expectedVersion: null, mediaType: 'image/jpeg', data: DATA });
  stub(json({ data: { photo: summary(5), replaced: true, replayed: false } }));
  expect((await fails(photoApi.set(scope, person, 2, 'image/jpeg', DATA, key, signal(), () => true))).kind).toBe('UNKNOWN');
  const g = stub(json({ data: { personId: person, removed: true, replayed: false } }));
  await photoApi.remove(scope, person, 2, key, signal(), () => true);
  expect((g.mock.calls[0] as unknown as [string])[0]).toBe('/api/v1/school/people/photo/remove');
  expect(JSON.parse(String((g.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ schoolId: school, personId: person, expectedVersion: 2 });
  const h = stub(json({}));
  expect((await fails(photoApi.set(scope, person, null, 'image/jpeg', 'not base64!', key, signal(), () => true))).kind).toBe('INVALID');
  expect(h).not.toHaveBeenCalled();
});

it('maps only exact refusals; everything else is unknown and kept for Try again; 401 ends the session', async () => {
  expect(photoErrorFor(403, 'PERSON_PHOTO_FORBIDDEN').kind).toBe('DENIED');
  expect(photoErrorFor(404, 'PERSON_PHOTO_NOT_FOUND').kind).toBe('MISSING');
  expect(photoErrorFor(404, null).kind).toBe('UNKNOWN');
  expect(photoErrorFor(409, 'PERSON_PHOTO_VERSION_CONFLICT').kind).toBe('CONFLICT');
  expect(photoErrorFor(400, 'PERSON_PHOTO_IMAGE_REFUSED').kind).toBe('INVALID');
  expect(photoErrorFor(503, 'PERSON_PHOTO_BUSY').kind).toBe('BUSY');
  expect(photoErrorFor(500, null).kind).toBe('UNKNOWN');
  expect(keepPhotoForRetry(new PhotoError('UNKNOWN'))).toBe(true);
  expect(keepPhotoForRetry(new PhotoError('CONFLICT'))).toBe(false);
  const seen = vi.fn(); (window as unknown as EventTarget).addEventListener(HON_SESSION_INVALIDATED_EVENT, seen);
  stub(new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } }));
  expect((await fails(photoApi.read(scope, person, signal(), () => true))).kind).toBe('SESSION');
  expect(seen).toHaveBeenCalledTimes(1);
});

it('photos are drawn at most 600 pixels on the longest side and never enlarged', () => {
  expect(photoSize(4032, 3024)).toEqual({ width: 600, height: 450 });
  expect(photoSize(1080, 1920)).toEqual({ width: 338, height: 600 });
  expect(photoSize(300, 200)).toEqual({ width: 300, height: 200 });
  expect(photoSize(0, 10)).toEqual({ width: 0, height: 0 });
});

const props = (over: Partial<PhotoCardProps> = {}): PhotoCardProps => ({ language: 'en', name: 'Mina Park', initials: 'MP', canEdit: true,
  read: { state: 'READY', photo: null }, draft: null, confirmRemove: false, outcome: null, locked: false, canRetry: false, ...over });

it('shows initials and a take-photo control without a photo, and the parent-consent reminder only to editors', () => {
  const html = renderToStaticMarkup(<PhotoCard {...props()}/>);
  expect(html).toContain('No photo yet.'); expect(html).toContain('>MP<'); expect(html).toContain('Take or choose a photo');
  expect(html).toContain('capture="user"'); expect(html).toContain('ask a parent');
  const viewer = renderToStaticMarkup(<PhotoCard {...props({ canEdit: false, read: { state: 'READY', photo: photo as never } })}/>);
  expect(viewer).not.toContain('type="file"'); expect(viewer).toContain('does not include changing it'); expect(viewer).toContain(`data:image/jpeg;base64,${DATA}`);
  expect(viewer).toContain('alt="Photo of Mina Park"');
});

it('a picked photo is a preview until saved; remove asks first; outcomes and Try again are shown', () => {
  const draft = renderToStaticMarkup(<PhotoCard {...props({ draft: 'AAAA' })}/>);
  expect(draft).toContain('not saved yet'); expect(draft).toContain('Save photo'); expect(draft).toContain('data:image/jpeg;base64,AAAA');
  const ask = renderToStaticMarkup(<PhotoCard {...props({ read: { state: 'READY', photo: photo as never }, confirmRemove: true })}/>);
  expect(ask).toContain('Remove the photo of Mina Park?');
  const unknown = renderToStaticMarkup(<PhotoCard {...props({ outcome: { kind: 'UNKNOWN' }, canRetry: true, onTryAgain: () => {}, onStop: () => {} })}/>);
  expect(unknown).toContain('never saved twice'); expect(unknown).toContain('Try again');
  expect(renderToStaticMarkup(<PhotoCard {...props({ read: { state: 'DENIED' } })}/>)).toContain('does not include photos');
});

it('copy exists in English, Korean and Spanish; initials take the first letters', () => {
  for (const lang of ['en', 'ko', 'es']) expect(photoText(lang, 'removeAsk', { name: 'Mina' })).toContain('Mina');
  expect(photoText('ko', 'title')).toBe('사진'); expect(photoText('es-MX', 'title')).toBe('Foto');
  expect(initialsOf('mina', 'park')).toBe('MP'); expect(initialsOf('민아', '박')).toBe('민박');
});
