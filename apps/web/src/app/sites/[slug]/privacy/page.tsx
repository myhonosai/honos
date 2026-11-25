import React from 'react';
import type { Metadata } from 'next';
import { PolicyRoute, policyMetadata } from '../policy-route';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ slug: string }> };
export async function generateMetadata({ params }: Params): Promise<Metadata> { return policyMetadata((await params).slug, 'privacy'); }
export default async function SchoolSitePrivacyPage({ params }: Params) { return <PolicyRoute slug={(await params).slug} kind="privacy" />; }
