'use client';
import React from 'react';
import { useLocale } from '../localization/provider';
import { journeyText } from './catalog';
/** Ordinary UUID-only navigation; destination remains idle until a fresh authorized read. */
export function CrmJourneyLink({organizationId,schoolId,leadId}:{organizationId?:string;schoolId?:string;leadId?:string} = {}):React.ReactElement {
  const {preferences} = useLocale();
  const query = organizationId && schoolId && leadId ? `?${new URLSearchParams({organizationId,schoolId,leadId})}` : '';
  return <a href={`/staff/crm/journey${query}`}>{journeyText(preferences?.language ?? 'en','title')}</a>;
}
