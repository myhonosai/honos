/**
 * Text message piece counter, shared by the composer (live "1 text" / "picture message" hint) and the
 * Twilio adapter. A GSM-7 text holds 160 characters (153 per piece when joined); any other character
 * (Korean, emoji, Spanish á í ó ú) switches the whole text to UCS-2: 70 characters (67 per piece).
 * Smart encoding first swaps look-alike punctuation so ordinary English stays GSM-7.
 * Three or more pieces send as one MMS: at list price one MMS costs less than three SMS pieces.
 */
export const TEXT_MAX_CHARACTERS = 1600;
export const TEXT_MMS_MIN_PIECES = 3;

const GSM_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENSION = '\f^{}\\[~]|€';
const BASIC = new Set(GSM_BASIC);
const EXTENSION = new Set(GSM_EXTENSION);

const SMART: Readonly<Record<string, string>> = {
  '‘': "'", '’': "'", '‚': "'", '′': "'", '“': '"', '”': '"', '„': '"', '″': '"',
  '–': '-', '—': '-', '−': '-', '…': '...', ' ': ' ', ' ': ' ', ' ': ' ', '•': '-',
};

/** Replaces look-alike punctuation with GSM-7 characters (what Twilio Smart Encoding does). */
export function smartEncodeText(text: string): string {
  let out = '';
  for (const char of text) out += SMART[char] ?? char;
  return out;
}

export interface TextPieces {
  encoding: 'GSM7' | 'UCS2';
  /** Characters as the carrier counts them: GSM-7 septets (extension characters count 2) or UTF-16 units. */
  units: number;
  pieces: number;
  sendAs: 'SMS' | 'MMS';
  tooLong: boolean;
}

export function countTextPieces(text: string): TextPieces {
  const encoded = smartEncodeText(text);
  let gsm = true;
  let septets = 0;
  for (const char of encoded) {
    if (BASIC.has(char)) septets += 1;
    else if (EXTENSION.has(char)) septets += 2;
    else { gsm = false; break; }
  }
  const encoding = gsm ? 'GSM7' as const : 'UCS2' as const;
  const units = gsm ? septets : encoded.length;
  const [single, multi] = gsm ? [160, 153] : [70, 67];
  const pieces = units === 0 ? 0 : units <= single ? 1 : Math.ceil(units / multi);
  return { encoding, units, pieces, sendAs: pieces >= TEXT_MMS_MIN_PIECES ? 'MMS' : 'SMS', tooLong: encoded.length > TEXT_MAX_CHARACTERS };
}
