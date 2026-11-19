'use client';
import React, { useEffect, useRef } from 'react';
import { QRCodeDecoderErrorCorrectionLevel, QRCodeEncoder } from '@zxing/library';
import type { WalkInCardSurface } from '@hon/contracts';
import styles from './walk-in-kiosk.module.css';

/**
 * Walk-in kiosk card payment on the tablet (WK3b). Test mode only: the processor form takes only a Stripe *test* publishable
 * key, and the page offers the tablet form only when one is configured. The phone QR needs no key: it opens Stripe's own page.
 * Nothing here decides a payment: the tablet always asks the server, which asks the processor.
 */
const TEST_KEY = /^pk_test_[A-Za-z0-9]{10,250}$/;
/** The configured Stripe test publishable key, or null (a live key, or anything else, is never used). */
export function walkInStripeTestKey(value: string | undefined = process.env.NEXT_PUBLIC_HON_TUITION_STRIPE_TEST_PUBLISHABLE_KEY): string | null {
  return typeof value === 'string' && TEST_KEY.test(value) ? value : null;
}
/** The surfaces this tablet can show: the server's list, less the form when no test key is configured. */
export function walkInTabletSurfaces(server: readonly WalkInCardSurface[], testKey: string | null): WalkInCardSurface[] {
  return server.filter(surface => surface === 'HOSTED' || testKey !== null);
}

/** The QR code for `text` as SVG modules (quiet zone of 4). Throws when the text cannot be encoded. */
export function qrModules(text: string): { size: number; path: string } {
  const matrix = QRCodeEncoder.encode(text, QRCodeDecoderErrorCorrectionLevel.M).getMatrix();
  const width = matrix.getWidth(), quiet = 4;
  let path = '';
  for (let y = 0; y < width; y += 1) for (let x = 0; x < width; x += 1) if (matrix.get(x, y) === 1) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  return { size: width + quiet * 2, path };
}
export function WalkInQr({ url, label }: { url: string; label: string }): React.ReactElement {
  const { size, path } = qrModules(url);
  return <svg role="img" aria-label={label} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" data-testid="walkin-qr" className={styles.qr}>
    <rect width={size} height={size} fill="#fff"/><path d={path} fill="#000"/></svg>;
}

type StripeCheckout = { mount(el: HTMLElement): void; destroy(): void };
type StripeLike = { initEmbeddedCheckout(options: { fetchClientSecret: () => Promise<string>; onComplete?: () => void }): Promise<StripeCheckout> };
type StripeFactory = (key: string, options?: { stripeAccount?: string }) => StripeLike;
/** Stripe.js is always served by Stripe itself (it cannot be bundled); the version matches the API version the server uses. */
export const STRIPE_JS = 'https://js.stripe.com/basil/stripe.js';
let loading: Promise<StripeFactory> | null = null;
function loadStripeJs(): Promise<StripeFactory> {
  const ready = () => (globalThis as { Stripe?: StripeFactory }).Stripe;
  if (ready()) return Promise.resolve(ready()!);
  loading ??= new Promise<StripeFactory>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = STRIPE_JS; script.async = true; script.referrerPolicy = 'no-referrer';
    script.onload = () => { const s = ready(); if (s) resolve(s); else reject(new Error('stripe')); };
    script.onerror = () => reject(new Error('stripe'));
    document.head.appendChild(script);
  }).catch(error => { loading = null; throw error; });
  return loading;
}

/**
 * The processor's own card form inside the kiosk page, for this one payment. Card details go straight to Stripe in its frame;
 * the tablet never sees them. The session asks not to leave the page for card payments, so the tablet keeps its memory.
 */
export function WalkInCardForm({ testKey, clientSecret, accountRef, onComplete, onError }: {
  testKey: string; clientSecret: string; accountRef: string | null; onComplete: () => void; onError: () => void;
}): React.ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const done = useRef(onComplete), failed = useRef(onError);
  done.current = onComplete; failed.current = onError;
  useEffect(() => {
    let live = true, checkout: StripeCheckout | null = null;
    loadStripeJs()
      .then(Stripe => Stripe(testKey, accountRef ? { stripeAccount: accountRef } : {})
        .initEmbeddedCheckout({ fetchClientSecret: () => Promise.resolve(clientSecret), onComplete: () => { if (live) done.current(); } }))
      .then(c => { checkout = c; if (!live || !host.current) { c.destroy(); return; } c.mount(host.current); })
      .catch(() => { if (live) failed.current(); });
    return () => { live = false; checkout?.destroy(); };
  }, [testKey, clientSecret, accountRef]);
  return <div ref={host} className={styles.cardForm} data-testid="walkin-card-form"/>;
}
