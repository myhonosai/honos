import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { attendanceCardCheckDigits, isAttendanceCardCode, normalizeAttendanceCardCode, type AttendanceCard, type AttendanceCardsRead, type AttendanceCheckInResult } from '@hon/contracts';
import { code128cWidths, qrMatrix, qrNumericCodewords, reedSolomon } from '../src/components/attendance-cards/codes';
import { CardsError, cardsApi, cardsErrorFor, keepForRetry } from '../src/components/attendance-cards/http';
import { AVERY_PER_SHEET, CardFace, CardsView, averyPages, cardNameOf, type CardsViewProps, type Look, type PrintedCard } from '../src/components/attendance-cards/cards';
import { ScanView, todaysSessions, type ScanViewProps } from '../src/components/attendance-cards/scan';
import { cardsText } from '../src/components/attendance-cards/copy';
import { id } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const school = id(2), key = id(77), at = '2026-11-16T03:00:00.000Z';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as CardsError; } throw new Error('expected a failure'); };
const body24 = '012345678901234567890123', CODE = body24 + attendanceCardCheckDigits(body24);
const settings = { codeType: 'QR', showPhoto: true, showLogo: true, design: 'CLASSIC', photoApprovalRequired: false, version: 0, updatedAt: null, schoolName: 'Synthetic Dojo', logoUrl: 'https://example.invalid/logo.png', accentColor: '#112233',
  photoConsent: { required: false, profile: null, reason: 'OFF' } } as const;
const card = (studentProfileId: string, last4: string): AttendanceCard => ({ cardId: id(60), studentProfileId, last4, status: 'ACTIVE', version: 1, issuedAt: at, endedAt: null });
const student = (n: number, withCard = false) => ({ studentProfileId: id(n), personId: id(n + 100), givenName: `Kid${n}`, familyName: 'Synthetic', studentStatus: 'ACTIVE', hasPhoto: n % 2 === 0, card: withCard ? card(id(n), '4321') : null, photoConsent: 'NOT_REQUIRED' as const, photoConsentVersion: 0 });
const read: AttendanceCardsRead = { settings, maxPerPrint: 40, students: [student(10), student(11, true)] };
const look: Look = { codeType: 'QR', showPhoto: true, showLogo: true, design: 'CLASSIC', photoApprovalRequired: false };

it('QR encoder matches the ISO 18004 example (01234567, version 1-M) and builds a 21 x 21 symbol', () => {
  const data = qrNumericCodewords('01234567');
  expect(data.slice(0, 8).map(b => b.toString(2).padStart(8, '0'))).toEqual(['00010000', '00100000', '00001100', '01010110', '01100001', '10000000', '11101100', '00010001']);
  expect(reedSolomon(data).map(b => b.toString(2).padStart(8, '0'))).toEqual(['10100101', '00100100', '11010100', '11000001', '11101101', '00110110', '11000111', '10000111', '00101100', '01010101']);
  const m = qrMatrix(CODE);
  expect(m).toHaveLength(21); expect(m.every(r => r.length === 21)).toBe(true);
  expect(m[0]!.slice(0, 7).every(Boolean)).toBe(true); expect(m[13]![8]).toBe(true);
  expect(() => qrMatrix('1'.repeat(35))).toThrow();
});

it('Code 128 set C: start C, check symbol and stop, two digits per symbol', () => {
  const w = code128cWidths(CODE);
  expect(w.slice(0, 6)).toEqual([2, 1, 1, 2, 3, 2]);
  expect(w.slice(-7)).toEqual([2, 3, 3, 1, 1, 1, 2]);
  expect(w.length).toBe(6 * (1 + 13 + 1) + 7);
  expect(w.reduce((a, b) => a + b, 0)).toBe(11 * 15 + 13);
  expect(() => code128cWidths('123')).toThrow();
});

it('a card code has mod 97 check digits and scanner noise is tidied, anything else is refused', () => {
  expect(isAttendanceCardCode(CODE)).toBe(true);
  expect(isAttendanceCardCode(CODE.slice(0, 25) + ((Number(CODE[25]) + 1) % 10))).toBe(false);
  expect(normalizeAttendanceCardCode(` ${CODE.replace(/(\d{4})/g, '$1-')} `)).toBe(CODE);
  for (const bad of ['', 'abc', CODE + '1', `https://x.invalid/${CODE}`, 42]) expect(normalizeAttendanceCardCode(bad)).toBeNull();
});

it('only exact refusals are definitive; unknown and busy keep the exact request', () => {
  expect(cardsErrorFor(403, null).kind).toBe('DENIED');
  expect(cardsErrorFor(404, 'ATTENDANCE_SESSION_NOT_FOUND').kind).toBe('MISSING');
  expect(cardsErrorFor(404, null).kind).toBe('UNKNOWN');
  expect(cardsErrorFor(409, 'ATTENDANCE_CARD_VERSION_CONFLICT').kind).toBe('CONFLICT');
  expect(cardsErrorFor(503, 'ATTENDANCE_CARDS_BUSY').kind).toBe('BUSY');
  expect(cardsErrorFor(500, null).kind).toBe('UNKNOWN');
  expect(keepForRetry(new CardsError('UNKNOWN'))).toBe(true); expect(keepForRetry(new CardsError('BUSY'))).toBe(true); expect(keepForRetry(new CardsError('DENIED'))).toBe(false);
});

it('a print sends one closed body with the cards marker and key; the code comes back once', async () => {
  const f = stub(json({ data: { printId: id(70), replaced: 0, replayed: false, cards: [{ ...card(id(10), CODE.slice(-4)), code: CODE, printPhoto: true }] } }));
  const out = await cardsApi.print(school, [id(10)], key, signal(), () => true);
  expect(out.cards[0]!.code).toBe(CODE);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/school/attendance/cards/print');
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'attendance-cards', 'Idempotency-Key': key });
  expect(JSON.parse(init.body as string)).toEqual({ schoolId: school, studentProfileIds: [id(10)] });
  stub(json({ data: { printId: id(70), replaced: 0, replayed: false, cards: [{ ...card(id(12), CODE.slice(-4)), code: CODE, printPhoto: true }] } }));
  expect((await fails(cardsApi.print(school, [id(10)], key, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: { printId: id(70), replaced: 0, replayed: true, cards: [{ ...card(id(10), CODE.slice(-4)), code: CODE, printPhoto: true }] } }));
  expect((await fails(cardsApi.print(school, [id(10)], key, signal(), () => true))).kind).toBe('UNKNOWN');
});

it('a scan is checked in the browser first and sent with the scan marker', async () => {
  const f = stub(json({ data: { outcome: 'NOT_RECOGNIZED', student: null, card: null, attendance: null } }));
  expect((await fails(cardsApi.checkIn(school, id(40), '1234', 'PRESENT', key, signal(), () => true))).kind).toBe('INVALID');
  expect(f).not.toHaveBeenCalled();
  expect((await cardsApi.checkIn(school, id(40), CODE, 'LATE', key, signal(), () => true)).outcome).toBe('NOT_RECOGNIZED');
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/school/attendance/check-in');
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'attendance-scan' });
  expect(JSON.parse(init.body as string)).toEqual({ schoolId: school, sessionId: id(40), code: CODE, status: 'LATE' });
});

it('a card face shows the logo, photo or initials, name and a QR or barcode with the grouped digits', () => {
  const qr = renderToStaticMarkup(<CardFace language="en" settings={settings} look={look} card={{ studentProfileId: id(10), name: 'Kid10 Synthetic', initials: 'KS', code: CODE, photo: null }}/>);
  expect(qr).toContain('data-code-type="QR"'); expect(qr).toContain('Synthetic Dojo logo'); expect(qr).toMatch(/referrerpolicy="no-referrer"/i);
  expect(qr).toContain('>KS<'); expect(qr).toContain('0123 4567');
  const bar = renderToStaticMarkup(<CardFace language="en" settings={settings} look={{ ...look, codeType: 'BARCODE', showLogo: false, showPhoto: false }} card={{ studentProfileId: id(10), name: 'Kid10 Synthetic', initials: 'KS', code: CODE, photo: 'data:image/jpeg;base64,AAAA' }}/>);
  expect(bar).toContain('data-code-type="BARCODE"'); expect(bar).not.toContain('logo'); expect(bar).not.toContain('base64');
});

const view = (over: Partial<CardsViewProps> = {}) => renderToStaticMarkup(<CardsView language="en" read={{ state: 'READY', read }} look={look} selected={new Set()} confirmCancel={null}
  outcome={null} locked={false} canRetry={false} sheet={null} startAt={0} {...over}/>);
it('the card maker lists students with their card and offers the owner choice of code', () => {
  const html = view();
  expect(html).toContain('Barcode'); expect(html).toContain('QR code'); expect(html).toContain('Not saved yet');
  expect(html).toContain('Card ending 4321'); expect(html).toContain('No card');
  expect(view({ read: { state: 'DENIED' } })).toContain('does not include attendance cards');
  const kept = view({ outcome: { kind: 'UNKNOWN' }, canRetry: true, onTryAgain: () => undefined });
  expect(kept).toContain('Try again'); expect(kept).toContain('never saved twice');
  expect(view({ outcome: { kind: 'REPLAYED' } })).toContain('shown only once');
  const sheet = view({ sheet: [{ studentProfileId: id(10), name: 'Kid10 Synthetic', initials: 'KS', code: CODE, photo: null }] });
  expect(sheet).toContain('Cards ready to print'); expect(sheet).toContain('data-testid="card-face"'); expect(sheet).not.toContain('Save look');
});

it('cards print as "Family, Given" like a class roster, and fall back to whichever name is on file', () => {
  expect(cardNameOf('Miles', 'Kudo')).toBe('Kudo, Miles');
  expect(cardNameOf('Miles', '')).toBe('Miles'); expect(cardNameOf('', 'Kudo')).toBe('Kudo');
});

it('the sheet is laid out on Avery business card pages (2 x 5), starting on any label of a used sheet', () => {
  const cards: PrintedCard[] = Array.from({ length: 12 }, (_, i) => ({ studentProfileId: id(10 + i), name: `Kid${i}`, initials: 'K', code: CODE, photo: null }));
  const pages = averyPages(cards, 3);
  expect(AVERY_PER_SHEET).toBe(10); expect(pages).toHaveLength(2);
  expect(pages.every(p => p.length === AVERY_PER_SHEET)).toBe(true);
  expect(pages[0]!.slice(0, 3)).toEqual([null, null, null]); expect(pages[0]![3]).toBe(cards[0]);
  expect(pages[1]!.filter(Boolean)).toHaveLength(5); expect(pages[1]!.slice(5)).toEqual([null, null, null, null, null]);
  expect(averyPages(cards.slice(0, 2), 99)[0]![9]).toBe(cards[0]);
  expect(averyPages(cards.slice(0, 2), -4)[0]![0]).toBe(cards[0]);
  const html = view({ sheet: cards.slice(0, 3), startAt: 2 });
  expect(html).toContain('data-avery="8371"'); expect(html.match(/data-testid="avery-page"/g)).toHaveLength(1);
  expect(html.match(/data-testid="card-face"/g)).toHaveLength(3); expect(html.match(/data-empty="true"/g)).toHaveLength(7);
  expect(html).toContain('Start on label'); expect(html).toContain('Avery 8371');
});

it('cards print only in the saved look', () => {
  const picked = new Set([id(10)]);
  expect(view({ selected: picked })).not.toContain('data-testid="save-first"');
  const changed = view({ selected: picked, look: { ...look, codeType: 'BARCODE' } });
  expect(changed).toContain('Save the card look before printing'); expect(changed).toMatch(/disabled=""[^>]*data-testid="print-new"/);
  const sheet = view({ look: { ...look, codeType: 'BARCODE' }, sheet: [{ studentProfileId: id(10), name: 'Kid10 Synthetic', initials: 'KS', code: CODE, photo: null }] });
  expect(sheet).toContain('data-code-type="QR"');
});

it('photos print by default; a school that turns on parent approval sees who has it and records or withdraws it', () => {
  expect(view()).toContain('data-testid="photo-approval"'); expect(view()).not.toContain('data-testid="consent-needed"');
  const rule = { required: true, profile: null, reason: 'SCHOOL_POLICY' } as const;
  const students = [{ ...student(10), photoConsent: 'GIVEN' as const, photoConsentVersion: 1 }, { ...student(12), photoConsent: 'MISSING' as const }];
  const html = view({ read: { state: 'READY', read: { ...read, settings: { ...settings, photoApprovalRequired: true, photoConsent: rule }, students } } });
  expect(html).toContain('to approve the photo before it prints on a card'); expect(html).toContain('Parent photo approval');
  expect(html).toContain('On file'); expect(html).toContain('Withdraw'); expect(html).toContain('Not on file (initials)'); expect(html).toContain('Record approval');
  expect(view()).not.toContain('data-testid="consent-cell"');
  for (const l of ['ko', 'es']) expect(cardsText(l, 'consentNeeded')).not.toBe(cardsText('en', 'consentNeeded'));
});

it('photo consent is sent as one closed command and the reply is checked', async () => {
  const f = stub(json({ data: { studentProfileId: id(10), photoConsent: 'GIVEN', photoConsentVersion: 1, recordedAt: at, replayed: false } }));
  expect((await cardsApi.photoConsent(school, id(10), true, 0, key, signal(), () => true)).photoConsent).toBe('GIVEN');
  const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('/api/v1/school/attendance/cards/photo-consent'); expect(JSON.parse(init.body as string)).toEqual({ schoolId: school, studentProfileId: id(10), given: true, expectedVersion: 0 });
  expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBe('attendance-cards');
  stub(json({ data: { studentProfileId: id(11), photoConsent: 'GIVEN', photoConsentVersion: 1, recordedAt: at, replayed: false } }));
  expect((await fails(cardsApi.photoConsent(school, id(10), true, 0, key, signal(), () => true))).kind).toBe('UNKNOWN');
  expect((await fails(cardsApi.photoConsent(school, id(10), false, 0, key, signal(), () => true))).kind).toBe('INVALID');
});

const scanView = (over: Partial<ScanViewProps> = {}) => renderToStaticMarkup(<ScanView language="en" sessions={{ state: 'READY', sessions: [] }} sessionId="" status="PRESENT" code=""
  result={null} locked={false} canRetry={false} camera="UNSUPPORTED" {...over}/>);
it('the scan screen says what happened in plain words and never records an unknown card', () => {
  expect(scanView()).toContain('No classes today'); expect(scanView()).toContain('not a self-service kiosk'); expect(scanView()).toContain('USB scanner');
  const s = { outcome: 'RECORDED', student: { studentProfileId: id(10), personId: id(110), givenName: 'Mina', familyName: 'Synthetic', studentStatus: 'ACTIVE' },
    card: card(id(10), '1234'), attendance: { id: id(90), status: 'LATE', version: 1, recordedAt: at } } satisfies AttendanceCheckInResult;
  expect(scanView({ result: { kind: 'ANSWER', answer: s, photo: null } })).toContain('Mina Synthetic checked in (Late).');
  expect(scanView({ result: { kind: 'ANSWER', answer: { ...s, outcome: 'ALREADY_RECORDED' as const }, photo: null } })).toContain('already checked in');
  expect(scanView({ result: { kind: 'ANSWER', answer: { outcome: 'NOT_RECOGNIZED', student: null, card: null, attendance: null }, photo: null } })).toContain('Nothing was recorded');
  expect(scanView({ result: { kind: 'NOT_A_CODE' } })).toContain('not a card code');
  for (const l of ['ko', 'es']) expect(cardsText(l, 'RECORDED', { name: 'A', status: 'B' })).not.toBe(cardsText('en', 'RECORDED', { name: 'A', status: 'B' }));
});

it("today's classes exclude cancelled ones and other days", () => {
  const now = new Date(2026, 10, 16, 9, 0);
  const s = (n: number, startsAt: Date, status = 'SCHEDULED') => ({ sessionId: id(n), name: `C${n}`, startsAt: startsAt.toISOString(), endsAt: startsAt.toISOString(), roomName: null, capacity: 10, bookingPolicy: 'WALK_IN', status, createdAt: at }) as never;
  const out = todaysSessions([s(1, new Date(2026, 10, 16, 18)), s(2, new Date(2026, 10, 17, 9)), s(3, new Date(2026, 10, 16, 7)), s(4, new Date(2026, 10, 16, 10), 'CANCELLED')], now);
  expect(out.map(x => x.name)).toEqual(['C3', 'C1']);
});
