/**
 * 0653 pictures inside email blasts. A blast body holds whole lines {{picture:<assetId>}}; the worker reads which of them
 * are READY pictures of the blast's school (hon.communication_email_pictures, lease holder only) and the email adapter turns
 * the message into a plain-text part (each picture line becomes its /m/<token> link) and an HTML part (each picture line
 * becomes an image from that link). A picture line that matches no listed picture (deleted since, or written by a merge
 * tag) is dropped. A message without listed pictures stays text only.
 *
 * 0654 adds video lines {{video:<assetId>}}: the text part gets the video page link /v/<token>, the HTML part the video's
 * poster (/m/<token>/poster) linking to that page. Only videos whose 720p copy is DONE are listed.
 */
export interface EmailPicture {
  assetId: string;
  kind: 'IMAGE' | 'VIDEO';
  token: string;
  title: string;
  width: number;
  height: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const LINE = /^\{\{(picture|video):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}\}$/;
const TITLE = /^(?=\S)[^\u0000-\u001f\u007f]{1,100}(?<=\S)$/;
/** Pictures are shown at most this wide; most email clients lay out at about 600 pixels. */
export const EMAIL_PICTURE_MAX_WIDTH = 600;

/** The pictures the database listed, or null (no pictures: text only). Anything malformed lists no picture. */
export function verifyEmailPictures(value: unknown): EmailPicture[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length > 10) return [];
  const pictures: EmailPicture[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const p = item as Record<string, unknown>;
    if (Object.keys(p).sort().join() !== 'assetId,height,kind,title,token,width' || (p.kind !== 'IMAGE' && p.kind !== 'VIDEO')
      || typeof p.assetId !== 'string' || !UUID.test(p.assetId)
      || typeof p.token !== 'string' || !TOKEN.test(p.token) || typeof p.title !== 'string' || !TITLE.test(p.title)
      || !Number.isInteger(p.width) || !Number.isInteger(p.height) || (p.width as number) < 1 || (p.height as number) < 1
      || (p.width as number) > 20000 || (p.height as number) > 20000) return [];
    pictures.push({ assetId: p.assetId, kind: p.kind, token: p.token, title: p.title, width: p.width as number, height: p.height as number });
  }
  return pictures;
}

/** A public site origin fit for picture links (https, or http on localhost for local runs), or null. */
export function pictureOrigin(value: string | undefined): string | null {
  if (!value) return null;
  return /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(value) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(value) ? value : null;
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** The text and HTML parts of a message with pictures. */
export function renderEmailWithPictures(content: string, pictures: readonly EmailPicture[], origin: string): { text: string; html: string } {
  const byId = new Map(pictures.map(p => [p.assetId, p]));
  const text: string[] = [];
  const blocks: string[] = [];
  let paragraph: string[] = [];
  const close = () => { if (paragraph.length) { blocks.push(`<p style="margin:0 0 16px 0">${paragraph.join('<br>')}</p>`); paragraph = []; } };
  for (const line of content.replace(/\r\n?/g, '\n').split('\n')) {
    const match = LINE.exec(line);
    if (match) {
      const picture = byId.get(match[2]!);
      if (!picture || picture.kind !== (match[1] === 'video' ? 'VIDEO' : 'IMAGE')) continue;
      const width = Math.min(picture.width, EMAIL_PICTURE_MAX_WIDTH);
      const height = Math.max(1, Math.round(picture.height * width / picture.width));
      close();
      if (picture.kind === 'VIDEO') {
        const page = `${origin}/v/${picture.token}`, poster = `${origin}/m/${picture.token}/poster`;
        text.push(`${picture.title}: ${page}`);
        blocks.push(`<p style="margin:0 0 16px 0"><a href="${escapeHtml(page)}"><img src="${escapeHtml(poster)}" alt="${escapeHtml(picture.title)}" width="${width}" height="${height}" `
          + `style="display:block;max-width:100%;height:auto;border:0"></a><a href="${escapeHtml(page)}" style="color:#1f2933">${escapeHtml(picture.title)}</a></p>`);
        continue;
      }
      const src = `${origin}/m/${picture.token}`;
      text.push(src);
      blocks.push(`<p style="margin:0 0 16px 0"><img src="${escapeHtml(src)}" alt="${escapeHtml(picture.title)}" width="${width}" height="${height}" `
        + `style="display:block;max-width:100%;height:auto;border:0"></p>`);
      continue;
    }
    text.push(line);
    if (line.trim() === '') close(); else paragraph.push(escapeHtml(line));
  }
  close();
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>'
    + '<body style="margin:0;padding:24px;background:#ffffff;color:#1f2933;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5">'
    + `<div style="max-width:${EMAIL_PICTURE_MAX_WIDTH}px;margin:0 auto">${blocks.join('')}</div></body></html>`;
  return { text: text.join('\n'), html };
}
