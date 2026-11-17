import { websiteRedirect } from '../../server/website-origin';

export const dynamic = 'force-dynamic';

/** /terms on the app opens the Terms of Service on the public website, so either address works as the app-store link. */
export function GET(): Response {
  return websiteRedirect('/terms/');
}
