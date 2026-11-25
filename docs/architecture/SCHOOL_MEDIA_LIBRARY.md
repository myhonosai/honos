# School media library (BL3a, migration 0628)

Owner request (David, 2026-11-18): blasts with "image/video insert". Owner decisions:

- 2026-11-18: email shows pictures inline; a video appears in email as a thumbnail that opens a HON video page. Texts stay
  plain SMS (no MMS) and may carry a video page link.
- 2026-11-22 "Allow media storage": photos and media in texts and blasts, accepting a small monthly storage cost.
- No new provider or CDN: one private Supabase Storage bucket on the existing Supabase project.

BL3 is three pieces. This is **BL3a, the library of pictures**. BL3b (picture blocks in email blasts and the HTML email
part) and BL3c (video upload, thumbnail and video page) follow, each with its own review. Plan:
`/mnt/project-files/blasts/BL3_MEDIA_PLAN.md` (project files).

## What staff see

Marketing > Media (`/staff/marketing/media`, nav label "Pictures for emails"):

- Storage use: bytes held of 5 GB, and bytes uploaded this month of 10 GB.
- Upload pictures: JPEG, PNG or GIF, up to 25 MB each, several at once (sent one at a time). The name defaults to the file
  name.
- Each picture: a preview, its size and pixel size, Copy link (`<site>/m/<token>`), Rename, and Delete after a confirm step.
- A note that location and camera details are removed, and that anyone with a picture's link can see it.

## Permissions

| Code | Sensitive | Default | Allows |
|---|---|---|---|
| `marketing.media.read` | no | OWNER | the library and storage use |
| `marketing.media.manage` | yes | OWNER | upload, rename, delete |

Both are staff-assignable. Direct human only (HUMAN_USER, HUMAN_UI, no action request or delegation); the active school and
organization need live ESSENTIAL, CORE or COMPLETE access. AI employees, the Action Engine and delegated requests are refused
by the API and again by the database.

## Data

`hon.school_media_assets` (forced RLS, no policy, no runtime table privilege; reached only through definer functions):

- `kind` IMAGE, `media_type` image/jpeg, image/png or image/gif, `title` (1-100 characters, one trimmed line),
  `byte_size` (1 byte to 25 MiB), `sha256`, `width` and `height` (1-20000).
- `object_key` is always `media/<id>`; the database fixes it and no request can choose it. Keys carry no school id; every
  read is authorized from the row.
- `link_token`: 43 random URL-safe characters, unique, fixed for the life of the picture.
- `state`: PENDING, READY, DELETED, REMOVED. Forward only: PENDING to READY; PENDING or READY to DELETED; DELETED to REMOVED.
  Identity and content never change, every change bumps the version, and rows are never deleted (a trigger refuses DELETE
  and TRUNCATE).

## Upload

1. The upload transport admits only `POST .../marketing/media/upload` with `Content-Type` image/jpeg, image/png or image/gif,
   a `Content-Length` of 1 byte to 25 MiB, no compression and no query string. Before reading the body it also needs a
   cookie, the configured Origin and the upload's `X-HON-Human-Command` (`403 HUMAN_UI_REQUIRED` otherwise). At most four
   uploads are read into memory at once per API process, and one per client when the client address is known
   (`HON_PUBLIC_CLIENT_IP_HOPS`); `MEDIA_BUSY` otherwise. A body must arrive within 150 seconds or the connection is closed.
2. The upload guard is the browser human-command guard (exact Origin, same-origin fetch, `X-HON-Human-Command:
   marketing_media.upload`, no source or delegation headers) with picture body types instead of JSON. The title travels
   percent-encoded in `X-HON-Media-Title`.
3. If storage is off, the answer is `503 MEDIA_STORAGE_OFF` before any database call; nothing is reserved or stored.
4. The API checks the type from the bytes (it must match the declared type) and cleans the picture:
   - JPEG and PNG through the 0388 stripper (EXIF, XMP, IPTC, comments, PNG text chunks, anything after the end marker).
     A JPEG keeps only its EXIF orientation, rewritten as a minimal EXIF block holding nothing else, so phone photos are not
     shown sideways.
   - GIF: frames, colour tables, frame timing and the loop setting stay; comments, plain-text blocks, every other
     application block (XMP and the like) and anything after the trailer go.
   - Width and height are read from the cleaned file.
5. `begin_school_media_upload` reserves a PENDING row for exactly the cleaned size and SHA-256, under a per-school advisory
   lock that checks the caps, and answers with the fixed key.
6. The API stores the cleaned bytes under that key, then `finish_school_media_upload` checks the size and checksum and moves
   the picture to READY.
7. If storing fails, the API deletes the reservation and removes any partial file (best effort), and answers
   `MEDIA_STORAGE_FAILED`.
8. If the picture was deleted while its bytes were being stored, the finish step finds it no longer PENDING; the API removes
   the file again (best effort, then confirms REMOVED) and answers `409 MEDIA_DELETED`, so no file is left in the bucket.

A replay with the same Idempotency-Key answers with the picture as it is now: READY is returned without storing again;
PENDING is stored and confirmed; a deleted picture answers `409 MEDIA_DELETED`.

## Caps

Checked in the database under the per-school lock (`MEDIA_STORAGE_FULL`, `MEDIA_MONTHLY_LIMIT`, both 409):

- 5 GiB held per school: PENDING, READY and DELETED pictures whose file is not yet confirmed removed.
- 10 GiB uploaded per school per UTC calendar month (every upload counts, even if later deleted).

These are David's defaults and can be changed later in a migration.

## Links

- `GET /m/<token>` on the web (rewritten to `GET /v1/public/media/<token>` on the API). No session, cookie or tenant id is
  read. `resolve_school_media_link` answers only for a READY picture of an ACTIVE school and organization; the API then
  answers `302` to a five-minute signed link of the private bucket. `Cache-Control: no-store`, `Referrer-Policy:
  no-referrer`, no query string, GET or HEAD only.
- Limits: 600 reads a minute per client (the shared per-client limiter, its own `media` window, because email image proxies
  fetch for many readers) and 12,000 a minute per process.
- Delete stops the link at once (DELETED). The API then removes the file and confirms it (REMOVED). If storage is off or the
  removal fails, the picture stays DELETED and keeps counting toward the 5 GiB until a later removal; a background sweep is
  not part of BL3a.
- A suspended school's links open nothing. A lapsed entitlement does not stop links in emails already sent.

## Storage switch

Storage works only when `hon-api` has `HON_MEDIA_STORAGE_APPROVED=true` plus `HON_MEDIA_STORAGE_URL` (https origin),
`HON_MEDIA_STORAGE_KEY` and `HON_MEDIA_STORAGE_BUCKET`. Any missing or malformed value keeps it off. The bucket must be
private. Setup steps are in `docs/operations/RENDER_DEPLOYMENT.md`. The API uses the Supabase Storage REST API directly
(`apps/api/src/school-media/media-storage.ts`): upload with `x-upsert`, sign for 300 seconds, delete by prefix; redirects
are refused and a signed link must name the same file.

## Entry points (runtime EXECUTE only)

| Function | Permission | Notes |
|---|---|---|
| `read_school_media(subject)` | read | up to 500 PENDING or READY pictures, newest first, plus usage |
| `begin_school_media_upload(subject, p, key, request, correlation)` | manage | `{title, mediaType, byteSize, sha256, width, height}` |
| `finish_school_media_upload(subject, p, request, correlation)` | manage | `{assetId, byteSize, sha256}` must match |
| `rename_school_media(subject, p, key, request, correlation)` | manage | `{assetId, expectedVersion, title}` |
| `delete_school_media(subject, p, key, request, correlation)` | manage | `{assetId, expectedVersion}`; answers the key |
| `confirm_school_media_removed(subject, asset, request, correlation)` | manage | DELETED to REMOVED, repeatable |
| `resolve_school_media_link(token)` | none | the public link |

Every command has exact-request idempotency, an audit row and an inert outbox event carrying ids, sizes and states only
(no title, token or key). The actor is proved again after the authority locks and before returning.

## Evidence

- `packages/database/scripts/test-school-media-library-integrity.mjs` (`pnpm --filter @hon/database db:test-school-media`)
  over signed HTTP with the real storage client pointed at an in-memory stand-in.
- `apps/api/test/school-media.test.cjs` and `apps/web/test/school-media-ui.test.tsx`.

## Video (BL3c, migration 0654)

Owner decisions (David): 2026-11-18 "Email pictures, video as a link"; 2026-11-22 "Allow media storage" and "Allow 720p
copies". Spec of the plan: `/mnt/project-files/blasts/BL3_MEDIA_PLAN.md` (BL3c design).

- **Upload.** MP4, MOV and WebM up to 5 GB (`SCHOOL_MEDIA_LIMITS.videoMaxBytes`). `POST .../marketing/media/video/begin`
  (`marketing_media.video_begin`, `{title, mediaType, byteSize}`) reserves a PENDING video with the fixed key `media/<id>`
  within the 0628 caps and answers a one-time signed upload link for exactly that key. The browser PUTs the file straight to
  the private bucket (no cookies, no HON headers; progress is shown). `POST .../video/finish`
  (`marketing_media.video_finish`, `{assetId}`) reads the stored file's first 4 KiB with a ranged request: the total size
  must equal the started size (`409 MEDIA_UPLOAD_MISSING` / `MEDIA_UPLOAD_MISMATCH`) and the bytes must look like the
  declared type (an ISO base media box for MP4/MOV, the EBML header for WebM). Anything else posing as a video answers `400
  MEDIA_VIDEO_REFUSED`, and the video is abandoned with its files removed. A good file becomes READY with its copy QUEUED.
  A retried begin with the same key signs a fresh link for the same video. The upload is one PUT, not resumable: a broken
  upload is started again.
- **The 720p copy.** An in-process job in hon-api (`SchoolVideoCopyWorker`, every minute, one video at a time) runs only with
  `HON_MEDIA_VIDEO_COPIES_APPROVED=true` and media storage on, and only once `ffmpeg` and `ffprobe` answer on the host
  (otherwise it claims nothing and says so once, so no video spends its tries). It claims the oldest QUEUED video of an
  active school with a two-hour lease (`hon.claim_school_video_copy`), reads the original through a five-minute signed link
  with a fixed demuxer (`mov` or `matroska`, https only, never as a playlist), and writes an H.264/AAC MP4 that fits 1280x720
  (either way up, never upscaled) with faststart and no metadata or chapters, so location and camera details are dropped. A
  poster frame is cleaned like any picture. Both are stored at `media/<id>.720.mp4` and `media/<id>.poster.jpg` and the facts
  (sizes, checksum, width, height, length) are recorded as the code-owned service principal
  `00000000-0000-4000-8000-000000000654` (audit source `SYSTEM_SERVICE`). A failed try goes back to QUEUED; the third
  failure, or an expired third lease, is FAILED. A video deleted meanwhile has the two new files removed.
- **The original must not change.** The signed upload link stays usable after finish, so before reading the original and
  again before storing the copy, the job reads its first bytes and size: anything other than the size finish recorded, or
  bytes without a video signature, fails the try as `SIZE_CHANGED` and nothing is copied. ffmpeg gets 80 minutes and the
  copy upload 20, so a try ends inside its two-hour lease.
- **What is public.** Only HON's copy. `/m/<token>` opens the 720p copy, `/m/<token>/poster` the poster, and `/v/<token>`
  is a page (no account, `noindex`, no referrer) that plays the copy with its poster and shows the school's name, the title
  and nothing else (`GET /v1/public/media/<token>/page`). Each answers only for a READY video of an active school whose copy
  is DONE, and stops at once on delete. The uploaded original is never linked.
- **Staff see** each video with its poster once ready ("Preparing a smaller copy" before, a plain notice if it failed), its
  length and size, and Copy link gives the `/v/<token>` page.
- **Storage use** counts the original, the copy and the poster. Delete removes all three files in one call.
- **Hosting.** The copy runs on hon-api (0.5 CPU). A long video can take a while there; moving the job to its own worker
  is a later deploy decision. hon-api needs `ffmpeg` and `ffprobe` on its PATH (or `HON_FFMPEG_PATH` / `HON_FFPROBE_PATH`).
  On Render the API build ends with `.github/scripts/install-video-tools.sh`, which downloads fixed ffmpeg/ffprobe 6.1.1
  static release assets, checks each against its pinned SHA-256 and the features the job uses (libx264, aac, mjpeg, the
  mov and matroska demuxers, https input), and puts them in `apps/api/.video-tools/`; `render.yaml` points the two paths
  there. Any mismatch fails the build.
  At deploy, set the media bucket's file size limit to 5 GiB, so nothing larger can be stored with an upload link.
- **Startup check.** With media storage on, production and staging refuse to start without an https `HON_PUBLIC_ORIGIN`
  (`MEDIA_PUBLIC_ORIGIN_REQUIRED`), since every picture or video email would otherwise only be retried.
- **Known limit.** Finish finds the video through the library read (newest 500 items), so a video started long ago behind 500
  newer items has to be uploaded again.

Entry points added (runtime EXECUTE only): `begin_school_video_upload`, `finish_school_video_upload`,
`claim_school_video_copy`, `finish_school_video_copy`, `fail_school_video_copy`, `resolve_school_video_poster`,
`resolve_school_video_page`. Private helpers: `school_video_copy_record`, `school_blast_video_ids`.

Evidence: `packages/database/scripts/test-school-media-video-integrity.mjs` (`db:test-school-media-video`),
`apps/api/test/school-media-video.test.cjs` (runs the real ffmpeg when installed and checks the copy has no location or
camera data), `apps/web/test/school-media-video-ui.test.tsx`, `apps/web/test/school-blast-videos-ui.test.tsx`.

## Not in BL3a or BL3c

- WebP, SVG and other picture types; resizing or thumbnails of pictures.
- Resumable (chunked) video uploads, more than one copy size, and captions.
- A background sweep for DELETED files whose removal failed.
