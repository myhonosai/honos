import React from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { WEBSITE_PAGE_SLUG } from '@hon/contracts';
import { SiteRoute, siteMetadata } from '../site-route';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ slug: string; page: string }> };
export async function generateMetadata({ params }: Params): Promise<Metadata> { const p = await params; return siteMetadata(p.slug, p.page); }
export default async function SchoolSitePage({ params }: Params) {
  const p = await params;
  // '/home' is the site's front page; it lives at /sites/<address>.
  if (!WEBSITE_PAGE_SLUG.test(p.page) || p.page === 'home') notFound();
  return <SiteRoute slug={p.slug} pageSlug={p.page} />;
}
