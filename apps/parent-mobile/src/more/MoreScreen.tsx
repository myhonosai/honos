import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import type { ParentRead } from '../api/client';
import { useFamily } from '../family/family-data';
import { Body, Button, Card, Loading, Pill, Section, StateMessage, Title } from '../ui/parts';
import { radius, space, TOUCH, type, useColors } from '../ui/theme';
import { CANDIDATE_LABEL, formatDay, formatMoney, INTEREST_LABEL, INVOICE_LABEL, MEMBERSHIP_LABEL, PASS_LABEL } from './more-model';

type Area = 'billing' | 'passes' | 'testing' | 'library';
const AREAS: { key: Area; title: string; blurb: string }[] = [
  { key: 'billing', title: 'Membership & billing', blurb: 'Memberships and invoices' },
  { key: 'passes', title: 'Class passes', blurb: 'Passes and uses left' },
  { key: 'testing', title: 'Belt testing', blurb: 'Upcoming tests and results' },
  { key: 'library', title: 'Learning library', blurb: 'Videos and links from your school' },
];

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

export function MoreScreen({ onSignOut, version }: { onSignOut: () => void; version: string }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [area, setArea] = useState<Area | null>(null);
  const current = AREAS.find(a => a.key === area);
  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={{ padding: space.lg, paddingTop: insets.top + space.lg, paddingBottom: space.xxl }}>
      <Text style={{ color: c.muted, fontSize: type.caption, fontWeight: '700', letterSpacing: 1 }}>MORE</Text>
      <Title>{current ? current.title : 'Account'}</Title>
      {current ? (
        <View>
          <View style={{ marginTop: space.md, alignSelf: 'flex-start' }}><Button kind="quiet" label="‹ Back" accessibilityLabel="Back to More" onPress={() => setArea(null)} /></View>
          {area === 'billing' ? <BillingArea /> : area === 'passes' ? <PassesArea /> : area === 'testing' ? <TestingArea /> : <LibraryArea />}
        </View>
      ) : (
        <View style={{ marginTop: space.lg }}>
          {AREAS.map(a => (
            <Pressable key={a.key} accessibilityRole="button" accessibilityLabel={`Open ${a.title}`} onPress={() => setArea(a.key)}
              style={({ pressed }) => ({ minHeight: TOUCH + 16, borderRadius: radius.lg, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface,
                padding: space.lg, marginBottom: space.md, opacity: pressed ? 0.85 : 1, flexDirection: 'row', alignItems: 'center' })}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.text, fontSize: type.title, fontWeight: '700' }}>{a.title}</Text>
                <Text style={{ color: c.muted, marginTop: space.xs }}>{a.blurb}</Text>
              </View>
              <Text style={{ color: c.subtle, fontSize: type.title }}>›</Text>
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
  if (!read) return <Loading label="Loading billing" />;
  if (!read.ok) return <Unavailable what="Billing" reload={reload} />;
  const { memberships, invoices } = read.data;
  return (
    <View>
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
      <Text style={{ color: c.subtle, fontSize: type.caption, marginTop: space.md }}>Paying and changing a membership happen with your school. The app shows your school's records only.</Text>
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
