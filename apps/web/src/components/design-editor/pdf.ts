import type { CreativeDesignSize } from '@hon/contracts';

/**
 * Print PDF for a print-size design (D2). Each side is one PDF page: the artwork as a 300 dpi JPEG that covers the trim
 * plus a 1/8 inch bleed on every edge, and thin black trim marks in the margin outside the bleed. MediaBox, BleedBox and
 * TrimBox are set so a print shop can check them. A tiny built-in writer: no new dependency and no outside service.
 */
export const PRINT_BLEED = 9; // points (1/8 inch)
export const MARK_GAP = 3; // points between the bleed edge and a trim mark
export const MARK_LENGTH = 18; // points
export const PRINT_MARGIN = PRINT_BLEED + MARK_GAP + MARK_LENGTH + 6; // trim to paper edge

export type PdfImage = Readonly<{ jpeg: Uint8Array; width: number; height: number }>;

/** Page geometry in points: paper, bleed and trim boxes as [x0, y0, x1, y1]. */
export function printBoxes(size: Pick<CreativeDesignSize, 'width' | 'height'>) {
  const m = PRINT_MARGIN, b = PRINT_BLEED, w = size.width, h = size.height;
  return { media: [0, 0, w + 2 * m, h + 2 * m], bleed: [m - b, m - b, m + w + b, m + h + b], trim: [m, m, m + w, m + h] } as const;
}

/** The eight trim-mark segments [x0, y0, x1, y1]: each trim edge extended outward past the bleed at each corner. */
export function trimMarks(size: Pick<CreativeDesignSize, 'width' | 'height'>): number[][] {
  const [x0, y0, x1, y1] = printBoxes(size).trim, near = PRINT_BLEED + MARK_GAP, far = near + MARK_LENGTH;
  const out: number[][] = [];
  for (const [x, sx] of [[x0, -1], [x1, 1]] as const) {
    for (const [y, sy] of [[y0, -1], [y1, 1]] as const) {
      out.push([x, y + sy * near, x, y + sy * far]); // vertical, beyond the top or bottom edge
      out.push([x + sx * near, y, x + sx * far, y]); // horizontal, beyond the left or right edge
    }
  }
  return out;
}

const n = (v: number) => (Math.round(v * 1000) / 1000).toString();
const latin1 = (s: string) => Uint8Array.from(s, c => c.charCodeAt(0) & 0xff);

/** A PDF with one page per image, each image filling the bleed box of a page of this size. */
export function buildPrintPdf(size: Pick<CreativeDesignSize, 'width' | 'height'>, images: readonly PdfImage[], title = 'Design'): Uint8Array {
  const boxes = printBoxes(size), box = (b: readonly number[]) => `[${b.map(n).join(' ')}]`;
  const [bx0, by0, bx1, by1] = boxes.bleed;
  const marks = trimMarks(size).map(([a, b, c, d]) => `${n(a!)} ${n(b!)} m ${n(c!)} ${n(d!)} l S`).join('\n');
  // Objects: 1 catalog, 2 pages, 3 info, then for page i: page, content, image.
  const objects: (string | Uint8Array)[][] = [];
  const kids: string[] = [];
  images.forEach((image, i) => {
    const page = 4 + i * 3, content = page + 1, xobject = page + 2;
    kids.push(`${page} 0 R`);
    const stream = `q\n${n(bx1 - bx0)} 0 0 ${n(by1 - by0)} ${n(bx0)} ${n(by0)} cm\n/Im${i} Do\nQ\nq\n0 0 0 RG 0.25 w\n${marks}\nQ\n`;
    objects[page] = [`<< /Type /Page /Parent 2 0 R /MediaBox ${box(boxes.media)} /BleedBox ${box(boxes.bleed)} /TrimBox ${box(boxes.trim)} `
      + `/Resources << /XObject << /Im${i} ${xobject} 0 R >> >> /Contents ${content} 0 R >>`];
    objects[content] = [`<< /Length ${stream.length} >>\nstream\n${stream}endstream`];
    objects[xobject] = [`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 `
      + `/Filter /DCTDecode /Length ${image.jpeg.length} >>\nstream\n`, image.jpeg, '\nendstream'];
  });
  objects[1] = ['<< /Type /Catalog /Pages 2 0 R >>'];
  objects[2] = [`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${images.length} >>`];
  const safeTitle = title.replace(/[^\x20-\x7e]/g, '?').replace(/[()\\]/g, '\\$&');
  objects[3] = [`<< /Title (${safeTitle}) /Producer (HON OS) >>`];

  const parts: Uint8Array[] = [];
  let length = 0;
  const push = (part: string | Uint8Array) => { const bytes = typeof part === 'string' ? latin1(part) : part; parts.push(bytes); length += bytes.length; };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = length;
    push(`${i} 0 obj\n`);
    for (const part of objects[i]!) push(part);
    push('\nendobj\n');
  }
  const xref = length;
  push(`xref\n0 ${objects.length}\n0000000000 65535 f \n`);
  for (let i = 1; i < objects.length; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
