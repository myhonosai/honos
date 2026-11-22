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

## Not in BL3a

- Picture blocks in email blasts and the HTML email part (BL3b).
- Video, thumbnails, the video page and the 720p playback copy (BL3c).
- WebP, SVG and other picture types; resizing or thumbnails of pictures.
- A background sweep for DELETED files whose removal failed.
