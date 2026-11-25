import {
  SCHOOL_BLAST_LIMITS, schoolBlastBodyMax, schoolBlastBodyOk, schoolBlastNameOk, schoolBlastMediaCount, schoolBlastPictureIds, schoolBlastPictureLine, schoolBlastVideoIds, schoolBlastVideoLine, schoolBlastTextOk, type SaveSchoolBlastInput, type SchoolBlast,
  type SchoolBlastAudienceGroup, type SchoolBlastChannel, type SchoolBlastMergeField,
} from '@hon/contracts';

/** The composer's working copy, in memory only. Tags are typed as one comma-separated line. */
export type BlastDraft = Readonly<{
  blastId: string | null; version: number; name: string; channel: SchoolBlastChannel; subject: string; body: string;
  groups: readonly SchoolBlastAudienceGroup[]; tags: string;
}>;
export type BlastField = 'name' | 'subject' | 'body' | 'tags';
export type BlastProblem = 'name' | 'subject' | 'body' | 'bodyLength' | 'mergeTag' | 'pictures' | 'pictureGone' | 'videoGone' | 'groups' | 'tags';

const TAG = /^[A-Za-z0-9](?:[A-Za-z0-9 _-]{0,38}[A-Za-z0-9])?$/;
const MERGE = /\{\{(first_name|last_name|school_name|staff_name)\}\}/g;

export function newBlastDraft(channel: SchoolBlastChannel): BlastDraft {
  return { blastId: null, version: 0, name: '', channel, subject: '', body: '', groups: ['ACTIVE_STUDENTS'], tags: '' };
}
export function blastDraftOf(blast: SchoolBlast): BlastDraft {
  return { blastId: blast.blastId, version: blast.version, name: blast.name, channel: blast.channel, subject: blast.subject ?? '', body: blast.body,
    groups: blast.audience.groups, tags: blast.audience.tags.join(', ') };
}
export function tagList(text: string): string[] { return text.split(',').map(t => t.trim()).filter(Boolean); }

export function blastInput(d: BlastDraft): SaveSchoolBlastInput {
  return { blastId: d.blastId, expectedVersion: d.version, name: d.name.trim(), channel: d.channel, subject: d.channel === 'EMAIL' ? d.subject.trim() : null,
    body: d.body.trim(), audience: { groups: [...d.groups], tags: tagList(d.tags) } };
}

const MEDIA_LINE = /^\{\{(?:picture|video):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}\}$/;
function withoutMediaLines(body: string): string { return body.split('\n').filter(line => !MEDIA_LINE.test(line)).join('\n'); }
/** The picture ids of a body, in order of first use. */
export const pictureIdsOf = schoolBlastPictureIds;
/** 0654: the video ids of a body, in order of first use. */
export const videoIdsOf = schoolBlastVideoIds;
function insertLine(text: string, start: number, end: number, mediaLine: string): { text: string; cursor: number } {
  const s = Math.max(0, Math.min(start, text.length)), e = Math.max(s, Math.min(end, text.length));
  const before = text.slice(0, s), after = text.slice(e);
  const line = `${before && !before.endsWith('\n') ? '\n' : ''}${mediaLine}${after && !after.startsWith('\n') ? '\n' : ''}`;
  return { text: before + line + after, cursor: before.length + line.length };
}
/** Puts a picture on its own line where the cursor is (a selection is replaced). */
export function insertPicture(text: string, start: number, end: number, assetId: string): { text: string; cursor: number } {
  return insertLine(text, start, end, schoolBlastPictureLine(assetId));
}
/** 0654: puts a video (its poster, linking to its page) on its own line where the cursor is. */
export function insertVideo(text: string, start: number, end: number, assetId: string): { text: string; cursor: number } {
  return insertLine(text, start, end, schoolBlastVideoLine(assetId));
}
/** 0654: puts a plain link (an SMS has no pictures) where the cursor is, with a space either side when needed. */
export function insertLink(text: string, start: number, end: number, url: string): { text: string; caret: number } {
  const a = Math.max(0, Math.min(start, text.length)), b = Math.max(a, Math.min(end, text.length));
  const before = text.slice(0, a), after = text.slice(b);
  const piece = `${before && !/\s$/.test(before) ? ' ' : ''}${url}${after && !/^\s/.test(after) ? ' ' : ''}`;
  return { text: before + piece + after, caret: before.length + piece.length };
}
/** Takes every line of one picture out of the body. */
export function removePicture(text: string, assetId: string): string {
  const line = schoolBlastPictureLine(assetId);
  return text.split('\n').filter(l => l !== line).join('\n');
}
/** 0654: takes every line of one video out of the body. */
export function removeVideo(text: string, assetId: string): string {
  const line = schoolBlastVideoLine(assetId);
  return text.split('\n').filter(l => l !== line).join('\n');
}

/**
 * What stops a save, checked the way the server checks it (the server checks again). `ready` is the ids of the school's ready
 * pictures and `readyVideos` of its videos whose 720p copy is done, when the library has been read (absent: not checked here).
 */
export function blastProblems(d: BlastDraft, ready?: ReadonlySet<string>, readyVideos?: ReadonlySet<string>): BlastProblem[] {
  const input = blastInput(d), out: BlastProblem[] = [];
  if (!schoolBlastNameOk(input.name)) out.push('name');
  if (d.channel === 'EMAIL' && (!schoolBlastTextOk(input.subject, 1, SCHOOL_BLAST_LIMITS.subject) || /[\n\r\t]/.test(input.subject ?? ''))) out.push('subject');
  const strayBraces = (t: string) => /(\{\{|\}\})/.test(t.replace(MERGE, ''));
  // 0653/0654: in an email, a whole line {{picture:<id>}} or {{video:<id>}} is media, not a stray tag.
  const text = d.channel === 'EMAIL' ? withoutMediaLines(input.body) : input.body;
  if (strayBraces(text) || (d.channel === 'EMAIL' && strayBraces(input.subject ?? ''))) out.push('mergeTag');
  else if (input.body.length > schoolBlastBodyMax(d.channel)) out.push('bodyLength');
  else if (d.channel === 'EMAIL' && schoolBlastMediaCount(input.body) > SCHOOL_BLAST_LIMITS.pictures) out.push('pictures');
  else if (!schoolBlastBodyOk(input.body, d.channel)) out.push('body');
  if (ready && d.channel === 'EMAIL' && pictureIdsOf(input.body).some(id => !ready.has(id))) out.push('pictureGone');
  if (readyVideos && d.channel === 'EMAIL' && videoIdsOf(input.body).some(id => !readyVideos.has(id))) out.push('videoGone');
  if (d.groups.length < 1) out.push('groups');
  const tags = input.audience.tags;
  if (tags.length > SCHOOL_BLAST_LIMITS.tags || tags.some(t => !TAG.test(t)) || new Set(tags.map(t => t.toLowerCase())).size !== tags.length) out.push('tags');
  return out;
}

/** Puts {{field}} where the cursor was (or replaces the selection) and says where the cursor goes next. */
export function insertMergeTag(text: string, start: number, end: number, field: SchoolBlastMergeField): { text: string; caret: number } {
  const a = Math.max(0, Math.min(start, text.length)), b = Math.max(a, Math.min(end, text.length)), tag = `{{${field}}}`;
  return { text: text.slice(0, a) + tag + text.slice(b), caret: a + tag.length };
}

/** A datetime-local value (this device's time) as the instant the server takes, or null when it is not a real time. */
export function scheduleInstant(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const at = new Date(local);
  if (Number.isNaN(at.getTime())) return null;
  const [y, mo, d, h, mi] = local.split(/[-T:]/).map(Number) as [number, number, number, number, number];
  if (at.getFullYear() !== y || at.getMonth() + 1 !== mo || at.getDate() !== d || at.getHours() !== h || at.getMinutes() !== mi) return null;
  return at.toISOString();
}
/** Whether a schedule time is inside the window the server accepts (more than a minute ahead, at most 60 days). */
export function scheduleOk(instant: string | null, now: number = Date.now()): boolean {
  if (!instant) return false;
  const at = Date.parse(instant);
  return at > now + 60_000 && at <= now + SCHOOL_BLAST_LIMITS.scheduleDays * 86_400_000;
}
