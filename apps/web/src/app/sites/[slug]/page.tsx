import React from 'react';
import type { Metadata } from 'next';
import { SiteRoute, siteMetadata } from './site-route';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ slug: string }> };
export async function generateMetadata({ params }: Params): Promise<Metadata> { return siteMetadata((await params).slug, 'home'); }
export default async function SchoolSiteHome({ params }: Params) { return <SiteRoute slug={(await params).slug} pageSlug="home" />; }
