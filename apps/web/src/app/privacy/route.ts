import { websiteRedirect } from '../../server/website-origin';

export const dynamic = 'force-dynamic';

/** /privacy on the app opens the Privacy Policy on the public website, so either address works as the app-store link. */
export function GET(): Response {
  return websiteRedirect('/privacy/');
}
