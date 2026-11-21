/**
 * How many text-message parts a body takes, for the counter under the message box. GSM-7 text: 160 characters in one
 * part, 153 per part when split (extension characters such as { } [ ] ~ count twice). Anything else (emoji, Korean, …):
 * 70 UTF-16 units in one part, 67 per part when split. A guide only: carriers decide the final split.
 */
const GSM = new Set([...'@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà']);
const GSM_EXTENDED = new Set([...'^{}\\[~]|€\f']);

export type SmsSegments = Readonly<{ segments: number; unicode: boolean; perSegment: number }>;
export function smsSegments(body: string): SmsSegments {
  let septets = 0, unicode = false;
  for (const char of body) {
    if (GSM.has(char)) septets += 1;
    else if (GSM_EXTENDED.has(char)) septets += 2;
    else { unicode = true; break; }
  }
  const length = unicode ? body.length : septets;
  const single = unicode ? 70 : 160, split = unicode ? 67 : 153;
  if (length === 0) return { segments: 0, unicode, perSegment: single };
  if (length <= single) return { segments: 1, unicode, perSegment: single };
  return { segments: Math.ceil(length / split), unicode, perSegment: split };
}
