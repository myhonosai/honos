import { json, type RequestHandler } from 'express';

/**
 * The API's general JSON body parser.
 *
 * `inflate: false` makes body-parser refuse any gzip/deflate/br request body with 415
 * before a decompression stream is created. No HON client compresses request bodies,
 * and decompression is the path behind GHSA-27r3-jxmh-p828 (crafted compressed body
 * crashing the process). Keep this off even on a patched body-parser.
 */
export const GENERAL_JSON_LIMIT = '2mb';

export function generalJsonTransport(): RequestHandler {
  return json({ limit: GENERAL_JSON_LIMIT, strict: true, inflate: false });
}
