import React from 'react';
import { requireVerifiedWebSession } from '../../../server/require-web-session';
import { LanguageRegionSettings } from '../../../components/localization/settings';
export const dynamic='force-dynamic';
export const metadata={title:'HON OS | Language & Region',robots:{index:false,follow:false},referrer:'no-referrer'};
export default async function LanguageRegionPage():Promise<React.ReactElement>{await requireVerifiedWebSession();return <LanguageRegionSettings/>;}
