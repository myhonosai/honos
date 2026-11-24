import React from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { readPublicSite } from '../../../server/public-site';
import { findSitePage, SiteView } from '../../../components/school-site/site-view';

/** WB3: a school's published website at /sites/<address>[/<page>]. No account, no tenant id: the address alone names it. */
export async function siteMetadata(slug: string, pageSlug: string): Promise<Metadata> {
  const result = await readPublicSite(slug);
  const page = result.kind === 'site' ? findSitePage(result.site.document, pageSlug) : null;
  if (result.kind !== 'site' || !page) return { title: 'Website', referrer: 'no-referrer', robots: { index: false, follow: false } };
  // Search indexing stays off until the owner approves it for school sites.
  return { title: page.seo.title || `${page.title} | ${result.site.schoolName}`, description: page.seo.description || undefined,
    referrer: 'no-referrer', robots: { index: false, follow: false } };
}

export async function SiteRoute({ slug, pageSlug }: { slug: string; pageSlug: string }) {
  const result = await readPublicSite(slug);
  if (result.kind === 'missing') notFound();
  if (result.kind === 'unavailable') return <main style={{ padding: 32, fontFamily: 'system-ui' }}><h1>This website is not available right now.</h1><p>Please try again in a moment.</p></main>;
  if (!findSitePage(result.site.document, pageSlug)) notFound();
  return <SiteView schoolName={result.site.schoolName} document={result.site.document} pageSlug={pageSlug} base={`/sites/${slug}`} mode="public" />;
}
