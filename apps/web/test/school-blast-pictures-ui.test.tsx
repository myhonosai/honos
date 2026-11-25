import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { schoolBlastBodyOk, schoolBlastPictureIds, schoolBlastPictureLine, verifySchoolBlast } from '@hon/contracts';
import { blastErrorFor } from '../src/components/school-blasts/http';
import { BLAST_COPY } from '../src/components/school-blasts/copy';
import { blastProblems, insertPicture, newBlastDraft, removePicture } from '../src/components/school-blasts/format';
import { SchoolBlastsView, type SchoolBlastsViewProps } from '../src/components/school-blasts/view';
import { id } from './account-status-fixtures';

// 0653: pictures inside email blasts. A picture is a whole line {{picture:<id>}}; the composer inserts it from the library.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const A = 'ab0c8d0e-4b8a-4c1e-9b7a-2d6f5e4c3b2a', B = id(41), TOKEN = 'T'.repeat(43);
const line = (x: string) => `{{picture:${x}}}`;
const asset = (assetId: string, over: Record<string, unknown> = {}) => ({ assetId, kind: 'IMAGE', mediaType: 'image/png', title: `Picture ${assetId.slice(-2)}`, byteSize: 10,
  width: 640, height: 480, copyState: null, durationMs: null, state: 'READY', version: 2, linkToken: TOKEN, createdAt: '2026-11-22T08:00:00.000Z', readyAt: '2026-11-22T08:00:01.000Z', updatedAt: '2026-11-22T08:00:01.000Z', ...over }) as never;
const draft = (body: string, channel: 'EMAIL' | 'SMS' = 'EMAIL') => ({ ...newBlastDraft(channel), name: 'Open house', subject: channel === 'EMAIL' ? 'Hi' : '', body });
function props(over: Partial<SchoolBlastsViewProps> = {}): SchoolBlastsViewProps {
  return { language: 'en', waiting: false, concealed: false, hasSchool: true, list: { state: 'READY', blasts: [] }, selected: null, draft: draft(`Hello\n${line(A)}`),
    dirty: true, problems: [], preview: null, scheduleLocal: '', scheduleValid: false, ask: null, outcome: null, locked: false, canRetry: false,
    pictures: { state: 'READY', assets: [asset(A), asset(B)] }, pickerOpen: false, ...over };
}

it('the body rules match the database: whole picture lines, email only, up to 10, lower-case ids', () => {
  expect(schoolBlastPictureLine(A.toUpperCase())).toBe(line(A));
  expect(schoolBlastBodyOk(`Hi\n${line(A)}\nBye`, 'EMAIL')).toBe(true);
  expect(schoolBlastBodyOk(line(A), 'EMAIL')).toBe(true);
  expect(schoolBlastBodyOk(`Hi ${line(A)}`, 'EMAIL')).toBe(false);
  expect(schoolBlastBodyOk(line(A), 'SMS')).toBe(false);
  expect(schoolBlastBodyOk(`{{picture:${A.toUpperCase()}}}`, 'EMAIL')).toBe(false);
  expect(schoolBlastBodyOk(`${line(A)}\r\nx`, 'EMAIL')).toBe(false);
  expect(schoolBlastBodyOk(`${Array(10).fill(line(A)).join('\n')}\nx`, 'EMAIL')).toBe(true);
  expect(schoolBlastBodyOk(`${Array(11).fill(line(A)).join('\n')}\nx`, 'EMAIL')).toBe(false);
  expect(schoolBlastPictureIds(`${line(B)}\n${line(A)}\n${line(B)}`)).toEqual([B, A]);
  expect(verifySchoolBlast({ blastId: id(30), name: 'n', channel: 'EMAIL', subject: 's', body: `Hi\n${line(A)}`, audience: { groups: ['ACTIVE_STUDENTS'], tags: [] },
    status: 'DRAFT', version: 1, sendAt: null, queuedAt: null, cancelledAt: null, recipientCount: null, outcomes: null, deliveries: null,
    createdAt: '2026-11-18T08:00:00.000Z', updatedAt: '2026-11-18T08:00:00.000Z' }).body).toContain(line(A));
});

it('a picture is inserted on its own line at the cursor and removed with every copy of its line', () => {
  expect(insertPicture('Hello there', 5, 5, A)).toEqual({ text: `Hello\n${line(A)}\n there`, cursor: 6 + line(A).length + 1 });
  expect(insertPicture('Hello\n', 6, 6, A).text).toBe(`Hello\n${line(A)}`);
  expect(insertPicture('', 0, 0, A).text).toBe(line(A));
  expect(removePicture(`a\n${line(A)}\nb\n${line(A)}`, A)).toBe('a\nb');
});

it('the composer accepts picture lines in an email, refuses them in a text, and flags a picture no longer in the library', () => {
  expect(blastProblems(draft(`Hello\n${line(A)}`), new Set([A]))).toEqual([]);
  expect(blastProblems(draft(`Hello\n${line(A)}`, 'SMS'))).toContain('mergeTag');
  expect(blastProblems(draft(`Hello\n${line(A)}`), new Set([B]))).toContain('pictureGone');
  expect(blastProblems(draft(`${Array(11).fill(line(A)).join('\n')}\nx`))).toContain('pictures');
  expect(blastErrorFor(409, 'BLAST_PICTURE_NOT_READY').kind).toBe('PICTURE_GONE');
});

it('the composer shows the pictures in the email, a picker from the library, and the picture in the sample', () => {
  const html = renderToStaticMarkup(<SchoolBlastsView {...props()} />);
  expect(html).toContain('data-testid="blast-pictures"'); expect(html).toContain(`data-used="${A}"`); expect(html).toContain(`data-remove-picture="${A}"`);
  expect(html).not.toContain('data-testid="blast-picker"');
  const open = renderToStaticMarkup(<SchoolBlastsView {...props({ pickerOpen: true })} />);
  expect(open).toContain(`data-pick="${A}"`); expect(open).toContain(`data-pick="${B}"`); expect(open).toContain(`src="/m/${TOKEN}"`);
  expect(open).toMatch(/referrerpolicy="no-referrer"/i);
  const gone = renderToStaticMarkup(<SchoolBlastsView {...props({ pictures: { state: 'READY', assets: [asset(B)] } })} />);
  expect(gone).toContain('no longer in your library');
  const denied = renderToStaticMarkup(<SchoolBlastsView {...props({ pickerOpen: true, pictures: { state: 'DENIED' } })} />);
  expect(denied).toContain('See media');
  const text = renderToStaticMarkup(<SchoolBlastsView {...props({ draft: draft('Hello', 'SMS') })} />);
  expect(text).not.toContain('data-testid="blast-pictures"'); expect(text).toContain('without pictures');
  const sample = renderToStaticMarkup(<SchoolBlastsView {...props({ draft: { ...draft(`Hello\n${line(A)}`), blastId: id(30), version: 1 }, dirty: false,
    preview: { state: 'READY', preview: { blastId: id(30), version: 1, channel: 'EMAIL', matched: 1, outcomes: { QUEUED: 1, NO_CONSENT: 0, NO_ADDRESS: 0, DUPLICATE_ADDRESS: 0 },
      sample: { firstName: 'Ana', subject: 'Hi', body: `Hello Ana\n${line(A)}\n${line(id(99))}` } } } })} />);
  const shown = sample.slice(sample.indexOf('data-testid="blast-sample"'), sample.indexOf('</div>', sample.indexOf('data-testid="blast-sample"')));
  expect(shown).toContain(`data-picture="${A}"`); expect(shown).toContain(`src="/m/${TOKEN}"`); expect(shown).toContain('[Picture]'); expect(shown).not.toContain('{{picture:');
  for (const language of ['ko', 'es'] as const) expect(renderToStaticMarkup(<SchoolBlastsView {...props({ language })} />)).toContain(BLAST_COPY[language].picturesTitle);
});
