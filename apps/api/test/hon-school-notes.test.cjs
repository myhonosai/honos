const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const contracts = require('@hon/contracts');

// 0255 What HON remembers: the contract mirrors the database rule; the API exposes exactly three routes.
const ID = () => require('node:crypto').randomUUID();
const T = '2026-11-11T09:00:00.000Z';

test('0255 note text: plain school facts only; contacts, links, markup and bad lengths are refused', () => {
  for (const ok of ['We close the first week of August.', 'Kids classes are 45 minutes long.', 'Belt test fee is listed at the front desk', 'Open 9-12 Sat']) assert.equal(contracts.isHonSchoolNoteText(ok), true, ok);
  for (const bad of ['ab', 'x'.repeat(201), ' padded ', 'Two\nlines', 'Email coach@example.test', 'Call 555 123 4567', '(555)123-4567', 'https://x.test', 'www.x.test', 'a://b', '<b>x</b>', 7, null]) {
    assert.equal(contracts.isHonSchoolNoteText(bad), false, String(bad));
  }
  // Same rule as the database: code points (an astral character counts once), C1 controls and Unicode spaces at the
  // edges refused, Unicode spaces never hide an email or a phone number.
  assert.equal(contracts.isHonSchoolNoteText('\u{1F600}'.repeat(200)), true, '200 code points');
  assert.equal(contracts.isHonSchoolNoteText('\u{1F600}'.repeat(201)), false, '201 code points');
  assert.equal(contracts.isHonSchoolNoteText('Caf\u00e9 hours are 9 to 5.'), true);
  for (const bad of ['Next\u0085step here', '\u00a0padded note', 'padded note\u3000', 'Line\u2028break', '555\u00a0123\u00a04567 is the line', 'mail a@b\u00a0x']) {
    assert.equal(contracts.isHonSchoolNoteText(bad), false, JSON.stringify(bad));
  }
  assert.deepEqual(contracts.validateHonSchoolNoteInput({ text: 'We close the first week of August.' }), { text: 'We close the first week of August.' });
  for (const bad of [{}, { text: 'ok note', extra: 1 }, { text: 'ab' }, null, 'text']) assert.throws(() => contracts.validateHonSchoolNoteInput(bad));
});

test('0255 read and receipt shapes are exact', () => {
  const note = { id: ID(), text: 'We close the first week of August.', createdAt: T };
  const page = { notes: [note], canManage: true, limits: { maxNotes: 20, maxCharacters: 2000, noteCharacters: 200 } };
  assert.deepEqual(contracts.validateHonSchoolNotes(page), page);
  for (const bad of [{ ...page, extra: 1 }, { ...page, canManage: 'yes' }, { ...page, notes: [{ ...note, author: 'x' }] }, { ...page, notes: [note, note] },
    { ...page, limits: { ...page.limits, maxNotes: 30 } }, { ...page, notes: [{ ...note, text: 'mail a@b.test' }] }]) assert.throws(() => contracts.validateHonSchoolNotes(bad), undefined, JSON.stringify(bad));
  assert.deepEqual(contracts.validateHonSchoolNoteReceipt({ record: { note }, replayed: false }).record, { note });
  assert.deepEqual(contracts.validateHonSchoolNoteReceipt({ record: { noteId: note.id, deleted: true }, replayed: true }), { record: { noteId: note.id, deleted: true }, replayed: true });
  for (const bad of [{ record: { noteId: note.id, deleted: false }, replayed: true }, { record: { note, noteId: note.id }, replayed: false }, { record: { note } }]) assert.throws(() => contracts.validateHonSchoolNoteReceipt(bad));
  assert.equal(contracts.HON_REPLY_SOURCE_LABELS.schoolNotes, 'School notes');
});

test('0255 API: three school-notes routes under the HON human-UI guard; writes need an Idempotency-Key and validate before the database', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/hon-conversation/hon-conversation.controller.ts'), 'utf8');
  assert.match(src, /@Get\('school-notes'\)/);
  assert.match(src, /@Post\('school-notes'\)/);
  assert.match(src, /@Post\('school-notes\/:noteId\/delete'\)/);
  assert.match(src, /hon\.read_hon_school_notes\(\$1\)/);
  assert.match(src, /hon\.add_hon_school_note\(\$1,\$2::jsonb,\$3,current_setting\('app\.hon_request_id'\)::uuid,/);
  assert.match(src, /hon\.delete_hon_school_note\(\$1,\$2::jsonb,\$3,current_setting\('app\.hon_request_id'\)::uuid,/);
  assert.match(src, /validateHonSchoolNoteInput\(input\)/);
  assert.match(src, /HON_SCHOOL_NOTES_FULL/);
});
