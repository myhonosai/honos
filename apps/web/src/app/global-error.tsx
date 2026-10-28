'use client';

import { useEffect } from 'react';
import { reportClientError } from '../components/client-error-report';

// Last-resort boundary when the root layout itself fails. It reports only the error name and
// Next.js digest, shows the digest as a support reference, and offers a retry.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { reportClientError(error, 'render'); }, [error]);
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, padding: '48px 16px', background: '#ffffff', color: '#111827' }}>
        <main style={{ maxWidth: 480, margin: '0 auto' }}>
          <h1 style={{ fontSize: 22 }}>HON could not load this page</h1>
          <p>Please try again. If this keeps happening, share the support reference below with HON support.</p>
          {error.digest ? <p style={{ fontSize: 14, color: '#4b5563' }}>Support reference: <code>{error.digest}</code></p> : null}
          <button type="button" onClick={reset} style={{ padding: '10px 16px', fontSize: 16 }}>Try again</button>
        </main>
      </body>
    </html>
  );
}
