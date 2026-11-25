import type { SchoolVideoType } from '@hon/contracts';

/** ISO base media (MP4 and QuickTime MOV) top-level box types that can open a file. */
const ISO_BOXES = new Set(['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip']);

/**
 * 0654: does the start of a stored file look like the video type it was declared as? MP4 and MOV share the ISO base
 * media layout (a box size then a four-letter box type, usually ftyp), so either declaration takes either; WebM is an EBML
 * file. This only stops other files posing as video. The 720p copy job reads it with a fixed demuxer and the public
 * links only ever serve HON's own copy.
 */
export function videoSignatureOk(mediaType: SchoolVideoType, head: Buffer): boolean {
  if (head.length < 12) return false;
  if (mediaType === 'video/webm') return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
  const size = head.readUInt32BE(0);
  const type = head.subarray(4, 8).toString('latin1');
  return ISO_BOXES.has(type) && (size === 1 || size === 0 || size >= 8);
}

/** The ffmpeg demuxer for a declared type, so a file can never be read as a playlist or another format. */
export function videoDemuxer(mediaType: SchoolVideoType): 'mov' | 'matroska' {
  return mediaType === 'video/webm' ? 'matroska' : 'mov';
}
