'use client';

import { useEffect, useState } from 'react';

type State = 'checking' | 'signed-out' | 'active' | 'forbidden' | 'unavailable';

export function HqAccessIndicator(): React.ReactElement {
  const [state, setState] = useState<State>('checking');
  useEffect(() => {
    fetch('/api/v1/hq/session', { cache: 'no-store' })
      .then((response) => setState(response.ok ? 'active' : response.status === 401 ? 'signed-out' : response.status === 403 ? 'forbidden' : 'unavailable'))
      .catch(() => setState('unavailable'));
  }, []);
  if (state === 'checking') return <div className="hq-auth-state"><span>HQ ACCESS</span><strong>Verifying governed session…</strong></div>;
  if (state === 'active') return <div className="hq-auth-state signed-in"><span>HQ OWNER ACTIVE</span><strong>Current account authorized</strong><small>Separate HQ policy gate is healthy.</small></div>;
  if (state === 'signed-out') return <a className="hq-sign-in" href="/auth/login"><span>ACCOUNT REQUIRED</span><strong>Sign in with Manus</strong><small>Verify the current account before HQ access. →</small></a>;
  if (state === 'forbidden') return <div className="hq-auth-state"><span>HQ ACCESS</span><strong>Account lacks HQ authority</strong><small>School permissions never grant control-plane access.</small></div>;
  return <div className="hq-auth-state"><span>HQ ACCESS</span><strong>Access gate temporarily unavailable</strong><small>HON stays fail-closed until it can verify the session.</small></div>;
}
