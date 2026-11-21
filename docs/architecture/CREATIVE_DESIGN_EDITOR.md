# Creative Studio design editor (D1, migration 0617)

Owner request (David, 2026-11-20): "something like canvas in there to make poster and stuff with ease with ai help". Plan
approved the same evening with the recommended defaults ("Just do these first"). Plan doc:
https://claude.ai/artifact/GqFthtSQhrTAjqgNo1h1hh

HON's own drag-and-drop editor inside Creative Studio. It does not embed or copy any outside design product.

## Pieces

| Piece | What | Migration |
| --- | --- | --- |
| D1 | Saved designs per school, uploaded photos, the editor canvas (text, shapes, lines, photos, layers, undo, autosave) | 0617 |
| D2 | Starter templates, brand kit (school color and contact line from 0285 branding), QR code, PNG and print PDF with bleed and trim marks | 0617 (QR element kind, added before merge) |
| D3 | AI writing ("make me a flyer for...", rewrite, translate); off until text AI is switched on | later |
| D4 | AI pictures (creative credits) and one-click resize; waits for C3/C4 storage and approval | later |
| D5 | Send a design to a post, campaign or blast; same editor in HQ | later |

## Owner defaults (accepted 2026-11-20)

- Designing needs `creative.design.manage`; seeing designs needs `creative.design.read`. Both staff-assignable, given to
  OWNER by default and to every role that already holds `marketing.social.manage` when 0617 runs.
- Editing, templates and downloads cost nothing. Only AI pictures (D4) use creative credits.
- Free web/system fonts only; no paid font licences.
- Download only; ordering prints is a later paid add-on that needs its own approval.

## D1 contract

### Sizes (closed list, `CREATIVE_DESIGN_SIZES`)

Print sizes are in points (72 per inch) and export at 300 dpi; screen sizes are in pixels.

| Code | Size | Sides |
| --- | --- | --- |
| FLYER_LETTER | 8.5 x 11 in (612 x 792 pt) | 1 |
| FLYER_HALF | 5.5 x 8.5 in (396 x 612 pt) | 1 |
| POSTER_11X17 | 11 x 17 in (792 x 1224 pt) | 1 |
| POSTER_18X24 | 18 x 24 in (1296 x 1728 pt) | 1 |
| POSTCARD_4X6 | 6 x 4 in landscape (432 x 288 pt) | 2 |
| POSTCARD_5X7 | 7 x 5 in landscape (504 x 360 pt) | 2 |
| SOCIAL_SQUARE | 1080 x 1080 px | 1 |
| SOCIAL_STORY | 1080 x 1920 px | 1 |
| EVENT_COVER | 1920 x 1005 px | 1 |

The size never changes after a design is created (D4 resize makes a new design).

### Document (version 1)

`{ v: 1, pages: Page[] }` with exactly as many pages as the size has sides. `Page = { background: '#RRGGBB', elements: Element[] }`,
at most 150 elements a page. Every element has `id` (`[a-z0-9-]{1,40}`, unique in the design), `kind`, `x`, `y`, `w`, `h`
(finite, within -2x..3x the page size, `w`,`h` > 0 except a line's), `rotation` (-360..360), `opacity` (0..1) and `locked`.

| kind | extra keys |
| --- | --- |
| text | `text` (1-2,000 characters, new lines allowed), `font` (SANS, SERIF, DISPLAY, ROUNDED, HANDWRITING, MONO), `size` (4-600), `bold`, `italic`, `color`, `align` (left, center, right), `lineHeight` (0.8-3) |
| rect | `fill` (color or null), `stroke` (color or null), `strokeWidth` (0-200), `radius` (0-2,000) |
| ellipse | `fill`, `stroke`, `strokeWidth` |
| line | `stroke` (color), `strokeWidth` (0.5-200); drawn from (x, y) to (x + w, y + h) |
| image | `imageId` (a design photo of the same school), `fit` (cover or contain) |
| qr | `data` (1-200 printable ASCII characters, usually a link), `color`, `background` (color or null); drawn square in its box, error correction M |

Colors are `#RRGGBB`. The whole document is at most 300,000 characters as JSON. The database checks the same shape
(`hon.creative_design_document_ok`) and that every `imageId` is a photo of the same school.

### Photos

Staff upload JPEG, PNG or WebP photos (at most 1,400,000 bytes each; the editor shrinks large photos first). The API removes
image metadata with the 0388 stripper and the table refuses any image that still carries it. Photos are private to the
school, never changed, at most 300 and 150,000,000 bytes per school. Deleting photos is a later piece.

### Commands

All are direct human browser commands (same-origin, X-HON-Human-Command, Idempotency-Key on POST), live paid access, the
actor proved again after the locks and before returning. Exact replay returns the first answer; a reused key with
different input is refused.

| Route (`/v1/organizations/:org/schools/:school/creative-studio/designs`) | Permission | Database entry point |
| --- | --- | --- |
| GET `` (status ACTIVE or ARCHIVED) | read | `read_school_creative_designs` |
| GET `/:designId` | read | `read_school_creative_design` |
| POST `` save (new: `designId` null, `expectedVersion` 0) | manage | `save_school_creative_design` |
| POST `/:designId/status` archive or restore | manage | `set_school_creative_design_status` |
| POST `/photos` upload | manage | `add_school_creative_design_photo` |
| GET `/photos/:photoId` | read | `read_school_creative_design_photo` |

Designs are never deleted; each change is the next version under the exact expected version; an archived design must be
restored before it changes. At most 200 active and 1,000 designs in all per school. Audit and outbox carry ids, size and
version only, never the text or photos.

## D2 (templates, brand kit, QR code, print PDF)

- Starter templates are laid out in fractions of the page, so each one works on every size. They are built in the
  browser and saved as an ordinary new design; nothing is stored for a template.
- Brand kit: when the person can read the school's branding (0285, `school_branding.manage`), the editor offers the
  school's accent color as a swatch and in templates, and an "add contact line" button. The logo is an outside https
  link, so it is not drawn on the canvas (that would need an outside fetch); staff upload the logo as a photo instead.
- QR codes are encoded in the browser with the `@zxing/library` encoder the app already ships (walk-in kiosk cards).
- Print PDF (print sizes only): one page per side at 300 dpi, 0.125 in bleed on every edge, trim marks outside the bleed,
  TrimBox and BleedBox set. Written by a small built-in PDF writer (one JPEG image and vector marks per page); no
  outside service or new dependency.

## What stays off

No AI provider, paid service, print ordering, payment or outside call. Nothing is sent or published from the editor in D1.
