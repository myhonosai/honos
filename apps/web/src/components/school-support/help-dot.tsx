'use client';
import React, { useEffect, useState } from 'react';
import { useSchoolShell } from '../school-shell/context';
import { supportApi, type SupportApi } from './http';

export const HELP_DOT_POLL_MS = 180_000;

/**
 * 0713: a dot on the header Help button when HON support answered and waits on this school. Read for the shell-verified
 * school only, on load and every few minutes; a person without support.request (403) or any failure simply shows no
 * dot. Presentation only: the request page still reads and authorizes everything itself.
 */
export function SchoolHelpDot({ api = supportApi, label }: { api?: SupportApi; label: string }): React.ReactElement | null {
  const shell = useSchoolShell();
  const org = shell.phase === 'READY' ? shell.selection?.organizationId ?? null : null;
  const school = shell.phase === 'READY' ? shell.selection?.schoolId ?? null : null;
  const [count, setCount] = useState(0);
  useEffect(() => {
    setCount(0);
    if (!org || !school) return;
    let live = true, abort = new AbortController();
    const read = () => {
      abort.abort(); abort = new AbortController();
      api.list({ organizationId: org, schoolId: school }, AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]), () => live).then(
        (list) => { if (live) setCount(list.awaitingSchoolCount); }, () => { if (live) setCount(0); });
    };
    read();
    const timer = setInterval(read, HELP_DOT_POLL_MS);
    return () => { live = false; abort.abort(); clearInterval(timer); };
  }, [api, org, school]);
  if (count === 0) return null;
  return <span data-help-dot={count} aria-label={label} title={label}
    style={{ position: 'absolute', top: 4, right: 4, width: 10, height: 10, borderRadius: 999, background: '#ffb84d', boxShadow: '0 0 0 2px #0a1625' }} />;
}
