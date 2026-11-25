import React from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { SchoolSitePolicyKind } from '@hon/contracts';
import { readPublicSite } from '../../../server/public-site';
import { SitePolicyView } from '../../../components/school-site/site-policy';

/** A2P step 2: /sites/<address>/privacy and /terms exist on every published site; an offline or unknown site has neither. */
export async function policyMetadata(slug: string, kind: SchoolSitePolicyKind): Promise<Metadata> {
  const result = await readPublicSite(slug);
  const title = kind === 'privacy' ? 'Privacy policy' : 'Terms of use';
  return { title: result.kind === 'site' ? `${title} | ${result.site.schoolName}` : title, referrer: 'no-referrer', robots: { index: false, follow: false } };
}

export async function PolicyRoute({ slug, kind }: { slug: string; kind: SchoolSitePolicyKind }) {
  const result = await readPublicSite(slug);
  if (result.kind === 'missing') notFound();
  if (result.kind === 'unavailable') return <main style={{ padding: 32, fontFamily: 'system-ui' }}><h1>This page is not available right now.</h1><p>Please try again in a moment.</p></main>;
  return <SitePolicyView schoolName={result.site.schoolName} document={result.site.document} kind={kind} base={`/sites/${slug}`} />;
}
