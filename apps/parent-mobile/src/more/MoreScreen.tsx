import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Text } from '../ui/text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import type { ParentRead, ParentWrite } from '../api/client';
import type { ParentInvoicePayOutcome, ParentPayableInvoice } from '@hon/contracts/parent-invoice-pay';
import { useFamily } from '../family/family-data';
import { Body, Button, Card, Loading, Pill, Section, StateMessage, Title, BackButton } from '../ui/parts';
import { Icon, type IconName } from '../ui/icons';
import { radius, space, TOUCH, type, useColors, EDGE, type Colors } from '../ui/theme';
import { CheckoutArea } from './CheckoutArea';
import { EventsArea } from './EventsArea';
import { ProShopArea } from './ProShopArea';
import { ReferArea } from './ReferArea';
import { CANDIDATE_LABEL, formatDay, formatMoney, INTEREST_LABEL, INVOICE_LABEL, MEMBERSHIP_LABEL, PASS_LABEL } from './more-model';

export type Area = 'events' | 'checkout' | 'billing' | 'passes' | 'testing' | 'shop' | 'library' | 'refer';
const AREAS: { key: Area; title: string; blurb: string; icon: IconName; tone: Tone }[] = [
  { key: 'events', title: 'Events & bookings', blurb: 'School events and family bookings', icon: 'ticket', tone: 'violet' },
  { key: 'checkout', title: 'Sign up & pay', blurb: 'Camps, events and more from your school', icon: 'check', tone: 'lime' },
  { key: 'billing', title: 'Membership & billing', blurb: 'Memberships and invoices', icon: 'card', tone: 'accent' },
  { key: 'passes', title: 'Class passes', blurb: 'Passes and uses left', icon: 'pass', tone: 'cyan' },
  { key: 'testing', title: 'Belt testing', blurb: 'Upcoming tests and results', icon: 'trophy', tone: 'sun' },
  { key: 'shop', title: 'Pro shop', blurb: 'Gear and uniforms from your school', icon: 'bag', tone: 'coral' },
  { key: 'library', title: 'Learning library', blurb: 'Videos and links from your school', icon: 'book', tone: 'pink' },
  { key: 'refer', title: 'Refer a friend', blurb: 'Share your link and see your rewards', icon: 'gift', tone: 'sun' },
];
type Tone = 'violet' | 'lime' | 'accent' | 'cyan' | 'sun' | 'coral' | 'pink';
function toneColors(c: Colors, t: Tone): [string, string] {
  return t === 'violet' ? [c.violetSoft, c.violet] : t === 'lime' ? [c.successSoft, c.success] : t === 'accent' ? [c.accentSoft, c.accent]
    : t === 'cyan' ? [c.cyanSoft, c.glowEdge] : t === 'sun' ? [c.warningSoft, c.warning] : t === 'coral' ? [c.coralSoft, c.coral] : [c.pinkSoft, c.pink];
}

/** One verified read per open area; any failure replaces the data, never stale content. */
function useRead<T>(load: () => Promise<ParentRead<T>>) {
  const [read, setRead] = useState<ParentRead<T> | null>(null);
  const generation = useRef(0);
  const reload = useCallback(() => {
    const mine = ++generation.current;
    setRead(null);
    void load().then(r => { if (mine === generation.current) setRead(r); });
  }, [load]);
  useEffect(() => { reload(); return () => { generation.current++; }; }, [reload]);
  return { read, reload };
}

function Unavailable({ what, reload }: { what: string; reload: () => void }) {
  return <StateMessage title={`${what} is unavailable`} body="We couldn't load this from your school right now. Nothing old is shown in its place." action={{ label: 'Try again', onPress: reload }} />;
}

export function MoreScreen({ onSignOut, version, openArea = null, openAt = 0 }: { onSignOut: () => void; version: string; openArea?: Area | null; openAt?: number }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [area, setArea] = useState<Area | null>(openArea);
  useEffect(() => { if (openArea) setArea(openArea); }, [openArea, openAt]);
  const current = AREAS.find(a => a.key === area);
  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={{ padding: space.lg, paddingTop: insets.top + space.lg, paddingBottom: space.xxl }}>
      {current ? <View style={{ alignSelf: 'flex-start', marginBottom: space.md }}><BackButton label="Back to More" onPress={() => setArea(null)} /></View> : null}
      <Text style={{ color: c.muted, fontSize: type.caption, fontWeight: '700', letterSpacing: 1 }}>MORE</Text>
      <Title>{current ? current.title : 'Account'}</Title>
      {current ? (
        <View>
          {area === 'events' ? <EventsArea /> : area === 'checkout' ? <CheckoutArea /> : area === 'billing' ? <BillingArea /> : area === 'passes' ? <PassesArea /> : area === 'testing' ? <TestingArea /> : area === 'shop' ? <ProShopArea /> : area === 'refer' ? <ReferArea /> : <LibraryArea />}
        </View>
      ) : (
        <View style={{ marginTop: space.lg }}>
          {AREAS.map(a => (
            <Pressable key={a.key} accessibilityRole="button" accessibilityLabel={`Open ${a.title}`} onPress={() => setArea(a.key)}
              style={({ pressed }) => ({ minHeight: TOUCH + 16, borderRadius: radius.lg, borderWidth: 2, borderColor: c.border, borderBottomColor: c.edge, backgroundColor: c.surface,
                borderBottomWidth: pressed ? 2 : 2 + EDGE, marginTop: pressed ? EDGE : 0, padding: space.md, marginBottom: space.md, flexDirection: 'row', alignItems: 'center', gap: space.md })}>
              <View style={{ width: 50, height: 50, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: toneColors(c, a.tone)[0] }}>
                <Icon name={a.icon} size={28} color={toneColors(c, a.tone)[1]} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.text, fontSize: type.title - 2, fontWeight: '800' }}>{a.title}</Text>
                <Text style={{ color: c.muted, marginTop: 2 }}>{a.blurb}</Text>
              </View>
              <Text style={{ color: c.subtle, fontSize: type.title, fontWeight: '800' }}>›</Text>
            </Pressable>
          ))}
          <Section>Security</Section>
          <Button kind="quiet" label="Sign out" onPress={onSignOut} />
          <Text style={{ color: c.subtle, fontSize: type.caption, marginTop: space.xl, textAlign: 'center' }}>HON Family {version}</Text>
        </View>
      )}
    </ScrollView>
  );
}

function BillingArea() {
  const { api, state } = useFamily();
  const c = useColors();
  const { read, reload } = useRead(api.billing);
  const zone = state.status === 'ready' ? state.timeZone : null;
  const [payRound, setPayRound] = useState(0);
  const [payNote, setPayNote] = useState<string | null>(null);
  // A payment that changed the invoice re-reads billing and the pay list; the processor's answer stays on screen.
  const paid = useCallback((message: string) => { setPayNote(message); setPayRound(n => n + 1); reload(); }, [reload]);
  if (!read) return <Loading label="Loading billing" />;
  if (!read.ok) return <Unavailable what="Billing" reload={reload} />;
  const { memberships, invoices } = read.data;
  return (
    <View>
      {payNote ? <Card style={{ marginTop: space.md }}><Text accessibilityLiveRegion="polite" style={{ color: c.text }}>{payNote}</Text></Card> : null}
      <PayInvoices key={payRound} zone={zone} onChanged={paid} />
      <Section>Memberships</Section>
      {memberships.status !== 'AVAILABLE' ? <Card><Body muted>{memberships.reason === 'PAYER_LINK_UNVERIFIED' ? 'Your school has not confirmed you as the billing contact, so memberships are not shown here.' : 'Memberships are not available right now.'}</Body></Card>
        : memberships.items.length === 0 ? <Card><Body muted>No memberships on your account.</Body></Card>
        : memberships.items.map((m, i) => (
          <Card key={`m-${i}`} label={`${m.participant.displayName} membership, ${MEMBERSHIP_LABEL[m.state].text}`}>
            <Text style={{ color: c.text, fontSize: type.title, fontWeight: '700' }}>{m.participant.displayName}</Text>
            <View style={{ marginTop: space.sm }}><Pill tone={MEMBERSHIP_LABEL[m.state].tone} text={MEMBERSHIP_LABEL[m.state].text} /></View>
            {m.termStartedAt || m.termEndsAt ? <Text style={{ color: c.muted, marginTop: space.sm }}>
              {m.termStartedAt ? `Started ${formatDay(m.termStartedAt, zone)}` : ''}{m.termStartedAt && m.termEndsAt ? ' · ' : ''}{m.termEndsAt ? `Ends ${formatDay(m.termEndsAt, zone)}` : ''}</Text> : null}
          </Card>
        ))}
      <Section>Invoices</Section>
      {invoices.status !== 'AVAILABLE' ? <Card><Body muted>{invoices.reason === 'PAYER_LINK_UNVERIFIED' ? 'Your school has not confirmed you as the billing contact, so invoices are not shown here.' : 'Invoices are not available right now.'}</Body></Card>
        : invoices.items.length === 0 ? <Card><Body muted>No invoices.</Body></Card>
        : invoices.items.map((inv, i) => (
          <Card key={`i-${i}`} label={`Invoice for ${inv.participant.displayName}, ${formatMoney(inv.totalMinor, inv.currency)}, ${INVOICE_LABEL[inv.status].text}`}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ color: c.text, fontSize: type.title, fontWeight: '700' }}>{formatMoney(inv.totalMinor, inv.currency)}</Text>
              <Pill tone={INVOICE_LABEL[inv.status].tone} text={INVOICE_LABEL[inv.status].text} />
            </View>
            <Text style={{ color: c.muted, marginTop: space.xs }}>{inv.participant.displayName}{inv.dueAt ? ` · Due ${formatDay(inv.dueAt, zone)}` : ''}</Text>
          </Card>
        ))}
      <Text style={{ color: c.subtle, fontSize: type.caption, marginTop: space.md }}>Changing a membership happens with your school. The app shows your school's records only.</Text>
    </View>
  );
}

const PAY_RESULT: Record<ParentInvoicePayOutcome, string> = {
  SUCCEEDED: 'Paid. Thank you! Your school has the payment.',
  PROCESSING: 'Your payment is still processing. Check back soon.',
  OPEN: 'Not paid yet. You can open the payment page again.',
  NONE: 'Not paid yet.',
  FAILED: 'The payment did not go through. Nothing was charged.',
  EXPIRED: 'The payment page timed out. Nothing was charged.',
  CANCELED: 'The payment was canceled. Nothing was charged.',
};
const PAY_REFUSED: Record<string, string> = {
  PARENT_INVOICE_PAY_NOT_PAYABLE: 'This invoice can no longer be paid here. Check with your school.',
  PARENT_INVOICE_PAY_IN_PROGRESS: 'A payment for this invoice is already in progress.',
  PARENT_INVOICE_PAY_AUTOPAY_IN_PROGRESS: 'Your school is already collecting this invoice.',
  PARENT_INVOICE_PAY_NOT_CONFIGURED: 'Your school does not take payments in the app yet.',
};

/**
 * Pay an open invoice on the school's own processor page (TEST mode). The app names only an invoice it read from
 * the pay list; HON opens the payment, the page belongs to the school's processor, and the answer after the page
 * closes is HON's record of the processor's answer. Nothing here claims "paid" from the page closing alone.
 */
function PayInvoices({ zone, onChanged }: { zone: string | null; onChanged: (message: string) => void }) {
  const { api, newKey } = useFamily();
  const c = useColors();
  const { read } = useRead(api.invoicePayments);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  // A start whose answer was lost is retried with the same Idempotency-Key, so a second press never opens a second payment.
  const startKeys = useRef(new Map<string, string>());
  if (!read) return null;
  if (!read.ok) return <Text style={{ color: c.muted, marginTop: space.md }}>Paying in the app is unavailable right now.</Text>;
  const { canPay, testMode } = read.data;
  const shown = read.data.invoices.filter(i => i.payable || i.payState === 'PROCESSING');
  if (!canPay || !shown.length) return null;
  const note = (id: string, text: string) => setNotes(n => ({ ...n, [id]: text }));
  const finish = (id: string, outcome: ParentWrite<{ state: ParentInvoicePayOutcome }>) => {
    if (outcome.ok && (outcome.data.state === 'SUCCEEDED' || outcome.data.state === 'PROCESSING')) onChanged(PAY_RESULT[outcome.data.state]);
    else if (outcome.ok) note(id, PAY_RESULT[outcome.data.state]);
    else note(id, "We couldn't check the payment yet. Open billing again in a moment to see it.");
  };
  const pay = async (inv: ParentPayableInvoice) => {
    const id = inv.invoiceId;
    setBusy(id);
    try {
      let key = startKeys.current.get(id);
      if (!key) { key = newKey(); startKeys.current.set(id, key); }
      const started = await api.startInvoicePayment(id, key);
      if (!started.ok) {
        if (started.state !== 'unknown') startKeys.current.delete(id);
        note(id, started.state === 'unknown' ? "We couldn't reach your school. Try again; you won't be charged twice."
          : (started.code && PAY_REFUSED[started.code]) || 'Paying is unavailable right now.');
        return;
      }
      startKeys.current.delete(id);
      if (started.data.state !== 'OPEN') { onChanged(PAY_RESULT[started.data.state]); return; }
      await WebBrowser.openBrowserAsync(started.data.url);
      finish(id, await api.confirmInvoicePayment(id, newKey()));
    } finally { setBusy(null); }
  };
  return (
    <View>
      <Section>Pay an invoice</Section>
      {testMode ? <Pill tone="warn" text="Test mode: no real money moves" /> : null}
      {shown.map(inv => (
        <Card key={inv.invoiceId}>
          <Text style={{ color: c.text, fontSize: type.title, fontWeight: '700' }}>{formatMoney(inv.balanceMinor, inv.currency)} due</Text>
          <Text style={{ color: c.muted, marginTop: space.xs }}>{inv.childName}{inv.dueAt ? ` · Due ${formatDay(inv.dueAt, zone)}` : ''}</Text>
          {inv.payState === 'PROCESSING' && !notes[inv.invoiceId] ? <Text style={{ color: c.muted, marginTop: space.sm }}>{PAY_RESULT.PROCESSING}</Text> : null}
          {notes[inv.invoiceId] ? <Text accessibilityLiveRegion="polite" style={{ color: c.text, marginTop: space.sm }}>{notes[inv.invoiceId]}</Text> : null}
          {inv.payable ? <View style={{ marginTop: space.md }}>
            {busy === inv.invoiceId ? <Loading label="Opening your school's payment page" />
              : <Button label={`Pay ${formatMoney(inv.balanceMinor, inv.currency)}`} accessibilityLabel={`Pay ${formatMoney(inv.balanceMinor, inv.currency)} for ${inv.childName}`}
                  onPress={() => { if (!busy) void pay(inv); }} />}
          </View> : null}
        </Card>
      ))}
      <Text style={{ color: c.subtle, fontSize: type.caption, marginTop: space.sm }}>You pay on your school's own card page. HON never sees or keeps your card.</Text>
    </View>
  );
}

function PassesArea() {
  const { api, state } = useFamily();
  const c = useColors();
  const { read, reload } = useRead(api.classPass);
  const zone = state.status === 'ready' ? state.timeZone : null;
  if (!read) return <Loading label="Loading class passes" />;
  if (!read.ok) return <Unavailable what="Class passes" reload={reload} />;
  const children = read.data.children.items.filter(ch => ch.passes.items.length);
  if (!children.length) return <Card style={{ marginTop: space.lg }}><Body muted>No class passes on your account.</Body></Card>;
  return (
    <View>
      {children.map((ch, i) => (
        <View key={`c-${i}`}>
          <Section>{ch.displayName}</Section>
          {ch.passes.items.map((p, j) => (
            <Card key={`p-${j}`} label={`${p.productDisplayName}, ${p.remainingUses} uses left, ${PASS_LABEL[p.status]}`}>
              <Text style={{ color: c.text, fontSize: type.title, fontWeight: '700' }}>{p.productDisplayName}</Text>
              <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.sm }}>
                <Pill tone={p.status === 'ACTIVE' ? 'good' : 'neutral'} text={PASS_LABEL[p.status]} />
                <Pill text={`${p.remainingUses} ${p.remainingUses === 1 ? 'use' : 'uses'} left`} />
              </View>
              <Text style={{ color: c.muted, marginTop: space.sm }}>Expires {formatDay(p.expiresAt, zone)}</Text>
            </Card>
          ))}
        </View>
      ))}
    </View>
  );
}

function TestingArea() {
  const { api, state } = useFamily();
  const c = useColors();
  const { read, reload } = useRead(api.testingStatus);
  const zone = state.status === 'ready' ? state.timeZone : null;
  if (!read) return <Loading label="Loading belt testing" />;
  if (!read.ok) return <Unavailable what="Belt testing" reload={reload} />;
  const children = read.data.children.items;
  if (!children.length) return <Card style={{ marginTop: space.lg }}><Body muted>No belt testing on your account yet.</Body></Card>;
  return (
    <View>
      {children.map((ch, i) => {
        const latest = newest(ch.candidates.items, x => x.event.startsAt);
        const interest = newest(ch.registrationInterests.items, x => x.submittedAt);
        return (
          <Card key={`t-${i}`} label={`Belt testing for ${ch.displayName}`} style={{ marginTop: i === 0 ? space.lg : 0 }}>
            <Text style={{ color: c.text, fontSize: type.title, fontWeight: '700' }}>{ch.displayName}</Text>
            <Text style={{ color: c.muted, marginTop: space.sm }}>{ch.upcomingEvent ? `Next test: ${ch.upcomingEvent.label}, ${formatDay(ch.upcomingEvent.startsAt, zone)}` : 'No upcoming test scheduled.'}</Text>
            {latest ? <View style={{ marginTop: space.sm }}><Pill tone={latest.overallStatus === 'PASSED' ? 'good' : 'neutral'} text={`${latest.event.label}: ${CANDIDATE_LABEL[latest.overallStatus]}`} /></View> : null}
            {interest ? <Text style={{ color: c.muted, marginTop: space.sm }}>{INTEREST_LABEL[interest.status]} ({interest.event.label})</Text> : null}
            {ch.certificate.status === 'ISSUED' ? <Text style={{ color: c.muted, marginTop: space.sm }}>Certificate issued. Ask your school for a copy.</Text> : null}
          </Card>
        );
      })}
      <Text style={{ color: c.subtle, fontSize: type.caption, marginTop: space.md }}>Results come from your school's records. Your instructor decides readiness for testing.</Text>
    </View>
  );
}

function LibraryArea() {
  const { api } = useFamily();
  const c = useColors();
  const { read, reload } = useRead(api.curriculumLibrary);
  if (!read) return <Loading label="Loading the learning library" />;
  if (!read.ok) return <Unavailable what="The learning library" reload={reload} />;
  const items = read.data.resources;
  if (!items.length) return <Card style={{ marginTop: space.lg }}><Body muted>Your school has not shared any videos or links yet.</Body></Card>;
  return (
    <View style={{ marginTop: space.lg }}>
      {items.map((r, i) => (
        <Card key={`r-${i}`} label={`${r.title} for ${r.childDisplayName}`}>
          <Text style={{ color: c.muted, fontSize: type.caption, fontWeight: '700' }}>{r.kind === 'VIDEO' ? 'VIDEO' : 'LINK'} · {r.childDisplayName.toUpperCase()}</Text>
          <Text style={{ color: c.text, fontSize: type.title, fontWeight: '700', marginTop: space.xs }}>{r.title}</Text>
          <Text style={{ color: c.muted }}>{r.curriculumName}{r.rankName ? ` · ${r.rankName}` : ''}</Text>
          {r.description ? <View style={{ marginTop: space.sm }}><Body>{r.description}</Body></View> : null}
          {/^https:\/\//.test(r.url) ? <View style={{ marginTop: space.md, alignSelf: 'flex-start' }}>
            <Button kind="quiet" label={r.kind === 'VIDEO' ? 'Watch' : 'Open link'} accessibilityLabel={`Open ${r.title}`} onPress={() => { void WebBrowser.openBrowserAsync(r.url); }} />
          </View> : null}
        </Card>
      ))}
    </View>
  );
}

function newest<T>(items: T[], at: (x: T) => string): T | undefined {
  return items.reduce<T | undefined>((best, x) => (!best || Date.parse(at(x)) > Date.parse(at(best)) ? x : best), undefined);
}
