'use client';
import React from 'react';
import { schoolCallNumberOk } from '@hon/contracts';
import { formatCallNumber } from './http';
import { requestPhoneCall } from './phone';
import { phoneCopy } from './phone-copy';

/**
 * "Call" next to a contact's number: opens the top-bar phone with the number filled in. It never dials by itself, and a
 * number HON will not call (outside the US and Canada, premium or special) shows no button. The server decides the rest.
 */
export function CallButton({ phoneE164, personId, name, language, className }: {
  phoneE164: string | null | undefined; personId?: string | undefined; name?: string | undefined; language: string; className?: string | undefined;
}): React.ReactElement | null {
  if (!phoneE164 || !schoolCallNumberOk(phoneE164)) return null;
  const copy = phoneCopy(language);
  return <button type="button" className={className} data-call-button=""
    aria-label={`${copy.call} ${name ?? formatCallNumber(phoneE164)}`}
    onClick={() => requestPhoneCall({ toE164: phoneE164, ...(personId ? { personId } : {}), ...(name ? { name } : {}) })}>
    {copy.call} {formatCallNumber(phoneE164)}</button>;
}
