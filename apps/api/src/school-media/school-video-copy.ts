import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SCHOOL_MEDIA_LIMITS, SCHOOL_VIDEO_TYPES, type SchoolVideoType } from '@hon/contracts';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { emitTelemetry } from '../observability/telemetry.js';
import { prepareMediaImage } from './media-image.js';
import { MediaStorage } from './media-storage.js';
import { videoDemuxer } from './media-video.js';

export const VIDEO_COPY_CLAIM = 'SELECT hon.claim_school_video_copy() AS data';
export const VIDEO_COPY_FINISH = 'SELECT hon.finish_school_video_copy($1::uuid,$2::uuid,$3::jsonb) AS data';
export const VIDEO_COPY_FAIL = 'SELECT hon.fail_school_video_copy($1::uuid,$2::uuid,$3) AS data';
/** ffmpeg may run this long for one video; the database lease is two hours. */
export const VIDEO_COPY_PROCESS_MS = 90 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Fit inside 1280 on the long side and 720 on the short side (720p either way up), never upscale, even sides. */
const SCALE = 'scale=w=trunc(iw*min(1\\,min(1280/max(iw\\,ih)\\,720/min(iw\\,ih)))/2)*2:h=trunc(ih*min(1\\,min(1280/max(iw\\,ih)\\,720/min(iw\\,ih)))/2)*2,setsar=1';

/** The 0654 switch: on only with HON_MEDIA_VIDEO_COPIES_APPROVED=true (David approved 720p copies 2026-11-22; a deploy turns it on). */
export function videoCopiesApproved(env: Record<string, string | undefined> = process.env): boolean {
  return env.HON_MEDIA_VIDEO_COPIES_APPROVED === 'true';
}

export interface VideoCopyJob { assetId: string; lease: string; mediaType: SchoolVideoType; byteSize: number; attempt: number; sourceKey: string; copyKey: string; posterKey: string }
export interface VideoCopyFacts { copyBytes: number; posterBytes: number; copySha256: string; width: number; height: number; durationMs: number }

/** Runs one program with arguments (no shell) and a deadline; resolves stdout, rejects on a non-zero exit or the deadline. */
export type ProcessRunner = (command: string, args: readonly string[], timeoutMs: number) => Promise<string>;
export const runProcess: ProcessRunner = (command, args, timeoutMs) => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
  let out = '', outBytes = 0;
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  child.stdout.on('data', (chunk: Buffer) => { outBytes += chunk.length; if (outBytes <= 1_000_000) out += chunk.toString('utf8'); });
  child.stderr.resume();
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(out); else reject(new Error('PROCESS_FAILED')); });
});

class CopyRefused extends Error { constructor(readonly code: string) { super(code); } }

/** Checks a claim answer exactly: fixed keys of the claimed id, a known type, a sane size. */
export function verifyVideoCopyJob(value: unknown): VideoCopyJob | null {
  if (value === null) return null;
  const row = value as Record<string, unknown>;
  const keys = ['assetId', 'attempt', 'byteSize', 'copyKey', 'lease', 'mediaType', 'posterKey', 'sourceKey'];
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join() !== keys.join()) throw new Error('UNVERIFIED_CLAIM');
  const id = row.assetId;
  if (typeof id !== 'string' || !UUID.test(id) || typeof row.lease !== 'string' || !UUID.test(row.lease)
    || !(SCHOOL_VIDEO_TYPES as readonly unknown[]).includes(row.mediaType)
    || !Number.isSafeInteger(row.byteSize) || (row.byteSize as number) < 1 || (row.byteSize as number) > SCHOOL_MEDIA_LIMITS.videoMaxBytes
    || !Number.isSafeInteger(row.attempt) || (row.attempt as number) < 1 || (row.attempt as number) > 3
    || row.sourceKey !== `media/${id}` || row.copyKey !== `media/${id}.720.mp4` || row.posterKey !== `media/${id}.poster.jpg`) throw new Error('UNVERIFIED_CLAIM');
  return row as unknown as VideoCopyJob;
}

export interface VideoCopyTools { ffmpeg: string; ffprobe: string; run: ProcessRunner; allowHttp: boolean }

/**
 * 0654 copy job: claim one QUEUED video, read the original through a five-minute signed link with a fixed demuxer (never
 * as a playlist), write an H.264/AAC MP4 of at most 720p with faststart and no metadata or chapters (location and camera
 * data are dropped), take a poster frame and clean it like any picture, store both, and record the facts. A failure goes
 * back to the database (QUEUED again, FAILED after the third try). A video deleted meanwhile has its two new files removed.
 */
@Injectable()
export class SchoolVideoCopyWorker {
  private tools: VideoCopyTools = {
    ffmpeg: process.env.HON_FFMPEG_PATH || 'ffmpeg', ffprobe: process.env.HON_FFPROBE_PATH || 'ffprobe', run: runProcess,
    allowHttp: process.env.NODE_ENV !== 'production',
  };
  constructor(private readonly database: RuntimeDatabaseService, private readonly storage: MediaStorage) {}

  /** For tests: other program paths and a stand-in runner. */
  withTools(tools: Partial<VideoCopyTools>): this { this.tools = { ...this.tools, ...tools }; this.toolsChecked = null; return this; }

  private toolsChecked: Promise<boolean> | null = null;
  /**
   * Whether ffmpeg and ffprobe answer at all, asked once. Without them nothing is claimed, so a host missing the programs
   * never spends a video's three tries; it says so once instead.
   */
  toolsReady(): Promise<boolean> {
    this.toolsChecked ??= Promise.all([this.tools.run(this.tools.ffmpeg, ['-version'], 15_000), this.tools.run(this.tools.ffprobe, ['-version'], 15_000)])
      .then(() => true, () => { emitTelemetry('error', 'school_media.video_copy_tools_missing', { component: 'school-media' }); return false; });
    return this.toolsChecked;
  }

  get enabled(): boolean { return videoCopiesApproved() && this.storage.configured; }

  /** One claimed video, start to finish. Answers what happened (NONE when there was nothing to do). */
  async runOnce(): Promise<'NONE' | 'DONE' | 'DISCARDED' | 'RETRY'> {
    if (!this.enabled || !(await this.toolsReady())) return 'NONE';
    const job = verifyVideoCopyJob(await this.database.runSchoolVideoCopyCall(VIDEO_COPY_CLAIM, []));
    if (!job) return 'NONE';
    const dir = await mkdtemp(join(tmpdir(), 'hon-video-'));
    try {
      let facts: VideoCopyFacts;
      try { facts = await this.makeCopy(job, dir); }
      catch (error) {
        const code = error instanceof CopyRefused ? error.code : 'COPY_FAILED';
        await this.storage.remove([job.copyKey, job.posterKey]).catch(() => undefined);
        await this.database.runSchoolVideoCopyCall(VIDEO_COPY_FAIL, [job.assetId, job.lease, code]);
        return 'RETRY';
      }
      const answer = await this.database.runSchoolVideoCopyCall(VIDEO_COPY_FINISH, [job.assetId, job.lease, JSON.stringify(facts)]) as Record<string, unknown> | null;
      if (answer?.assetId !== job.assetId) throw new Error('UNVERIFIED_FINISH');
      if (answer.discard === true) { await this.storage.remove([job.copyKey, job.posterKey]).catch(() => undefined); return 'DISCARDED'; }
      if (answer.copyState !== 'DONE') throw new Error('UNVERIFIED_FINISH');
      return 'DONE';
    } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
  }

  private async makeCopy(job: VideoCopyJob, dir: string): Promise<VideoCopyFacts> {
    const copyPath = join(dir, 'copy.mp4'), posterPath = join(dir, 'poster.jpg');
    const source = await this.storage.signedUrl(job.sourceKey);
    const protocols = this.tools.allowHttp ? 'http,https,tls,tcp' : 'https,tls,tcp';
    try {
      await this.tools.run(this.tools.ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', protocols, '-f', videoDemuxer(job.mediaType),
        '-i', source, '-map', '0:v:0', '-map', '0:a:0?', '-t', String(SCHOOL_MEDIA_LIMITS.maxDurationMs / 1000), '-vf', SCALE,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
        '-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact',
        '-movflags', '+faststart', '-f', 'mp4', '-y', copyPath], VIDEO_COPY_PROCESS_MS);
    } catch { throw new CopyRefused('COPY_FAILED'); }
    let probe: { streams?: { width?: unknown; height?: unknown }[]; format?: { duration?: unknown } };
    try {
      probe = JSON.parse(await this.tools.run(this.tools.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration',
        '-of', 'json', copyPath], 60_000));
    } catch { throw new CopyRefused('PROBE_FAILED'); }
    const width = probe.streams?.[0]?.width, height = probe.streams?.[0]?.height, seconds = Number(probe.format?.duration);
    const max = SCHOOL_MEDIA_LIMITS.copyMaxSide;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || (width as number) < 1 || (height as number) < 1 || (width as number) > max || (height as number) > max
      || !Number.isFinite(seconds) || seconds <= 0) throw new CopyRefused('PROBE_FAILED');
    const durationMs = Math.min(SCHOOL_MEDIA_LIMITS.maxDurationMs, Math.max(1, Math.round(seconds * 1000)));
    try {
      await this.tools.run(this.tools.ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file', '-ss', String(Math.min(1, seconds / 2)),
        '-f', 'mov', '-i', copyPath, '-frames:v', '1', '-map_metadata', '-1', '-q:v', '3', '-c:v', 'mjpeg', '-f', 'image2', '-y', posterPath], 120_000);
    } catch { throw new CopyRefused('POSTER_FAILED'); }
    let poster;
    try { poster = prepareMediaImage('image/jpeg', await readFile(posterPath)); } catch { throw new CopyRefused('POSTER_FAILED'); }
    const copyBytes = (await stat(copyPath)).size;
    if (copyBytes < 1 || copyBytes > SCHOOL_MEDIA_LIMITS.videoMaxBytes || poster.byteSize > SCHOOL_MEDIA_LIMITS.maxBytes) throw new CopyRefused('COPY_TOO_LARGE');
    const copySha256 = await new Promise<string>((resolve, reject) => {
      const hash = createHash('sha256');
      createReadStream(copyPath).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
    });
    try {
      await this.storage.putFile(job.copyKey, copyPath, copyBytes, 'video/mp4');
      await this.storage.put(job.posterKey, poster.bytes, 'image/jpeg');
    } catch { throw new CopyRefused('STORE_FAILED'); }
    return { copyBytes, posterBytes: poster.byteSize, copySha256, width: width as number, height: height as number, durationMs };
  }
}

/** In-process loop: one video at a time, a look every minute, only while the copy switch and media storage are on. */
@Injectable()
export class SchoolVideoCopyScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  constructor(private readonly worker: SchoolVideoCopyWorker) {}

  onModuleInit(): void {
    if (!this.worker.enabled) return;
    this.timer = setInterval(() => { void this.tick(); }, 60_000);
    this.timer.unref();
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Keep going while there is work, one video after another.
      for (let i = 0; i < 20; i += 1) {
        const outcome = await this.worker.runOnce();
        if (outcome === 'NONE') break;
        emitTelemetry('info', 'school_media.video_copy', { component: 'school-media', message: outcome });
      }
    } catch {
      emitTelemetry('error', 'school_media.video_copy_failed', { component: 'school-media' });
    } finally { this.running = false; }
  }
}
