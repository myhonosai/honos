import React from 'react';

// 0530: where the school's payment page returns after a parent pays (or leaves) in the HON Family app. It reads and
// records nothing: the app asks HON for the processor's own answer when the parent comes back to it.
export const dynamic = 'force-static';
export const metadata = { title: 'HON | Payment finished', description: 'Go back to the HON Family app.', referrer: 'no-referrer', robots: { index: false, follow: false } };

export default function ParentPaymentReturnPage() {
  return (
    <main style={{ maxWidth: 480, margin: '15vh auto', padding: '0 24px', fontFamily: 'system-ui, sans-serif', textAlign: 'center', lineHeight: 1.5 }}>
      <h1 style={{ fontSize: 24 }}>You can go back to the app</h1>
      <p>Close this page to return to HON Family. The app will show whether your payment went through.</p>
    </main>
  );
}
