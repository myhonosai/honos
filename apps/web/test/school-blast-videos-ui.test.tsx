import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { schoolBlastBodyOk, schoolBlastMediaCount, schoolBlastVideoIds, schoolBlastVideoLine } from '@hon/contracts';
import { blastErrorFor } from '../src/components/school-blasts/http';
import { BLAST_COPY } from '../src/components/school-blasts/copy';
import { blastProblems, insertLink, insertVideo, newBlastDraft, removeVideo } from '../src/components/school-blasts/format';
import { SchoolBlastsView, type SchoolBlastsViewProps } from '../src/components/school-blasts/view';
import { videoPageLink } from '../src/components/school-media/http';
import { id } from './account-status-fixtures';

// 0654: videos in blasts. An email takes a whole line {{video:<id>}} (its poster linking to its page); a text takes the page's plain link.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const V = 'cd0c8d0e-4b8a-4c1e-9b7a-2d6f5e4c3b2a', P = id(41), W = id(42), TOKEN = 'V'.repeat(43), PTOKEN = 'P'.repeat(43);
const vline = (x: string) => `{{video:${x}}}`, pline = (x: string) => `{{picture:${x}}}`;
const at = { createdAt: '2026-11-22T08:00:00.000Z', readyAt: '2026-11-22T08:00:01.000Z', updatedAt: '2026-11-22T08:00:01.000Z' };
const video = (assetId: string, over: Record<string, unknown> = {}) => ({ assetId, kind: 'VIDEO', mediaType: 'video/mp4', title: `Video ${assetId.slice(-2)}`, byteSize: 10,
  width: 1280, height: 720, copyState: 'DONE', durationMs: 65_000, state: 'READY', version: 3, linkToken: TOKEN, ...at, ...over }) as never;
const picture = (assetId: string) => ({ assetId, kind: 'IMAGE', mediaType: 'image/png', title: 'Picture', byteSize: 10, width: 640, height: 480,
  copyState: null, durationMs: null, state: 'READY', version: 2, linkToken: PTOKEN, ...at }) as never;
const draft = (body: string, channel: 'EMAIL' | 'SMS' = 'EMAIL') => ({ ...newBlastDraft(channel), name: 'Open house', subject: channel === 'EMAIL' ? 'Hi' : '', body });
function props(over: Partial<SchoolBlastsViewProps> = {}): SchoolBlastsViewProps {
  return { language: 'en', waiting: false, concealed: false, hasSchool: true, list: { state: 'READY', blasts: [] }, selected: null, draft: draft(`Hello\n${vline(V)}`),
    dirty: true, problems: [], preview: null, scheduleLocal: '', scheduleValid: false, ask: null, outcome: null, locked: false, canRetry: false,
    pictures: { state: 'READY', assets: [video(V), picture(P), video(W, { copyState: 'WORKING', linkToken: null, width: null, height: null, durationMs: null })] },
    pickerOpen: false, videoPickerOpen: false, ...over };
}

it('the body rules match the database: whole video lines, email only, pictures and videos together up to 10', () => {
  expect(schoolBlastVideoLine(V.toUpperCase())).toBe(vline(V));
  expect(schoolBlastBodyOk(`Hi\n${vline(V)}\nBye`, 'EMAIL')).toBe(true);
  expect(schoolBlastBodyOk(`Hi ${vline(V)}`, 'EMAIL')).toBe(false);
  expect(schoolBlastBodyOk(vline(V), 'SMS')).toBe(false);
  expect(schoolBlastBodyOk(`{{video:${V.toUpperCase()}}}`, 'EMAIL')).toBe(false);
  const mixed = (n: number, m: number) => [...Array(n).fill(pline(P)), ...Array(m).fill(vline(V)), 'x'].join('\n');
  expect(schoolBlastBodyOk(mixed(5, 5), 'EMAIL')).toBe(true);
  expect(schoolBlastBodyOk(mixed(5, 6), 'EMAIL')).toBe(false);
  expect(schoolBlastMediaCount(mixed(3, 4))).toBe(7);
  expect(schoolBlastVideoIds(`${vline(W)}\n${vline(V)}\n${vline(W)}`)).toEqual([W, V]);
});

it('a video is inserted on its own line and removed with every copy; a text gets the plain page link', () => {
  expect(insertVideo('Hello there', 5, 5, V).text).toBe(`Hello\n${vline(V)}\n there`);
  expect(removeVideo(`a\n${vline(V)}\nb\n${vline(V)}`, V)).toBe('a\nb');
  const url = videoPageLink('https://app.example.test/', TOKEN);
  expect(url).toBe(`https://app.example.test/v/${TOKEN}`);
  expect(insertLink('Watch:now', 6, 6, url)).toEqual({ text: `Watch: ${url} now`, caret: 7 + url.length + 1 });
  expect(insertLink('', 0, 0, url).text).toBe(url);
  expect(insertLink('See ', 4, 4, url).text).toBe(`See ${url}`);
});

it('the composer counts pictures and videos together and flags a video that is no longer ready', () => {
  expect(blastProblems(draft(`Hello\n${vline(V)}`), new Set(), new Set([V]))).toEqual([]);
  expect(blastProblems(draft(`Hello\n${vline(V)}`, 'SMS'))).toContain('mergeTag');
  expect(blastProblems(draft(`Hello\n${vline(V)}`), new Set(), new Set([W]))).toContain('videoGone');
  expect(blastProblems(draft(`${[...Array(6).fill(pline(P)), ...Array(5).fill(vline(V))].join('\n')}\nx`))).toContain('pictures');
  expect(blastErrorFor(409, 'BLAST_VIDEO_NOT_READY').kind).toBe('VIDEO_GONE');
  for (const c of Object.values(BLAST_COPY)) { expect(c.problems.videoGone).toBeTruthy(); expect(c.outcomes2.VIDEO_GONE).toBeTruthy(); expect(c.insertVideoLink).toBeTruthy(); }
});

it('an email shows its videos, and the picker offers only videos whose copy is done, by their posters', () => {
  const html = renderToStaticMarkup(<SchoolBlastsView {...props()} />);
  expect(html).toContain('data-testid="blast-videos"'); expect(html).toContain(`data-used-video="${V}"`); expect(html).toContain(`data-remove-video="${V}"`);
  expect(html).toContain('Insert video<'); expect(html).not.toContain('data-testid="blast-video-picker"');
  const open = renderToStaticMarkup(<SchoolBlastsView {...props({ videoPickerOpen: true })} />);
  expect(open).toContain(`data-pick-video="${V}"`); expect(open).toContain(`/m/${TOKEN}/poster`);
  expect(open).not.toContain(`data-pick-video="${W}"`); expect(open).not.toContain(`data-pick-video="${P}"`);
  // The picture picker never offers a video.
  const pictures = renderToStaticMarkup(<SchoolBlastsView {...props({ pickerOpen: true })} />);
  expect(pictures).toContain(`data-pick="${P}"`); expect(pictures).not.toContain(`data-pick="${V}"`);
  const none = renderToStaticMarkup(<SchoolBlastsView {...props({ videoPickerOpen: true, pictures: { state: 'READY', assets: [picture(P)] } })} />);
  expect(none).toContain('No ready videos yet');
});

it('a text offers the video link instead, and the sample shows a video line as its poster or a marker', () => {
  const sms = renderToStaticMarkup(<SchoolBlastsView {...props({ draft: draft('Hello', 'SMS'), videoPickerOpen: true })} />);
  expect(sms).toContain('Insert video link'); expect(sms).toContain(`data-pick-video="${V}"`); expect(sms).not.toContain('data-testid="blast-pictures"');
  const blast = { blastId: id(30), name: 'n', channel: 'EMAIL' as const, subject: 's', body: `Hi\n${vline(V)}\n${vline(W)}`, audience: { groups: ['ACTIVE_STUDENTS' as const], tags: [] },
    status: 'SENT' as never, version: 2, sendAt: null, queuedAt: '2026-11-22T09:00:00.000Z', cancelledAt: null, recipientCount: 1, outcomes: null, deliveries: null,
    createdAt: '2026-11-22T08:00:00.000Z', updatedAt: '2026-11-22T09:00:00.000Z' };
  const shown = renderToStaticMarkup(<SchoolBlastsView {...props({ draft: null, selected: { state: 'READY', blast: blast as never } })} />);
  expect(shown).toContain(`src="/m/${TOKEN}/poster"`); expect(shown).toContain(`data-video="${W}"`); expect(shown).toContain('[Video]');
  expect(shown).not.toContain('{{video:');
});
