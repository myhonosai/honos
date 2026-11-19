import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import type {
  FamilyCheckoutAnswer, FamilyCheckoutOption, FamilyCheckoutOrder, FamilyCheckoutPage, OpenParentCheckoutOrderInput, ParentCheckoutOrderStart, ParentCheckoutPages,
} from '@hon/contracts/family-checkout';
import type { ParentRead, ParentWrite } from '../api/client';
import { useFamily } from '../family/family-data';
import { Body, Button, Card, Loading, Pill, Section, StateMessage } from '../ui/parts';
import { radius, space, TOUCH, type, useColors } from '../ui/theme';
import { formatMoney } from './more-model';

export const CHECKOUT_REFUSALS: Record<string, string> = {
  FAMILY_CHECKOUT_NOT_FOUND: 'This page or one of your children is no longer available here.',
  FAMILY_CHECKOUT_CHANGED: 'This page changed. Here is the latest.',
  FAMILY_CHECKOUT_OPTION_UNAVAILABLE: 'This option is no longer available.',
  FAMILY_CHECKOUT_FULL: 'There are not enough places left.',
  FAMILY_CHECKOUT_WAIVER_REQUIRED: 'Please accept the waiver first.',
  FAMILY_CHECKOUT_RATE_LIMITED: 'Too many orders today. Please try again tomorrow.',
  FAMILY_CHECKOUT_FORBIDDEN: 'A guardian on the account can buy here.',
  FAMILY_CHECKOUT_NOT_CONFIGURED: 'Your school does not take payments in the app yet.',
  FAMILY_CHECKOUT_PAY_NOT_AVAILABLE: 'Your school cannot take a card payment in the app right now.',
  SCHOOL_PAY_ONCE_SURFACE_UNSUPPORTED: 'Your school cannot take a card payment in the app right now.',
  SCHOOL_PAY_ONCE_IN_PROGRESS: 'This payment is still being processed.',
  VALIDATION_FAILED: 'Check the children, answers and add-ons, then try again.',
};
export const ORDER_STATUS: Record<FamilyCheckoutOrder['status'], { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  PAID: { label: 'Paid', tone: 'good' }, OPEN: { label: 'Waiting for payment', tone: 'warn' }, UNPAID: { label: 'Not paid', tone: 'neutral' },
  CANCELED: { label: 'Canceled', tone: 'neutral' }, REVIEW: { label: 'Your school is checking this payment', tone: 'warn' },
};

export type CheckoutDraft = { children: string[]; answers: Record<string, Record<string, FamilyCheckoutAnswer | undefined>>; addOns: string[]; waiverAccepted: boolean };
export function emptyCheckoutDraft(page: FamilyCheckoutPage): CheckoutDraft {
  return { children: [], answers: {}, addOns: page.addOns.filter(a => a.required).map(a => a.key), waiverAccepted: false };
}
/** What the app shows as the total. The server prices the order itself; this is only the same rule shown ahead. */
export function checkoutTotal(page: FamilyCheckoutPage, option: FamilyCheckoutOption, d: CheckoutDraft): number {
  const n = Math.max(d.children.length, 1);
  const extra = option.additionalParticipantMinor ?? option.priceMinor;
  return option.priceMinor + extra * (n - 1) + page.addOns.filter(a => d.addOns.includes(a.key)).reduce((sum, a) => sum + a.amountMinor, 0);
}
function answered(kind: string, required: boolean, v: FamilyCheckoutAnswer | undefined): boolean {
  if (kind === 'CHECKBOX') return required ? v === true : v === undefined || typeof v === 'boolean';
  if (v === undefined) return !required;
  return typeof v === 'string' && v.trim() !== '';
}
/** Whether the order can be sent: children, every required answer, required add-ons and the waiver when there is one. */
export function checkoutReady(page: FamilyCheckoutPage, option: FamilyCheckoutOption, d: CheckoutDraft): boolean {
  if (!d.children.length || d.children.length > page.maxParticipants) return false;
  if (option.placesLeft !== null && option.placesLeft < d.children.length) return false;
  if (page.waiver && !d.waiverAccepted) return false;
  if (page.addOns.some(a => a.required && !d.addOns.includes(a.key))) return false;
  return d.children.every(ch => page.questions.every(q => answered(q.kind, q.required, d.answers[ch]?.[q.key])));
}
/** What is sent: the page's own ids and version, trimmed text, and only answers that were given. */
export function checkoutInput(page: FamilyCheckoutPage, option: FamilyCheckoutOption, d: CheckoutDraft): OpenParentCheckoutOrderInput {
  return {
    checkoutId: page.checkoutId, expectedVersion: page.version, optionKey: option.key, waiverAccepted: page.waiver !== null && d.waiverAccepted,
    addOns: page.addOns.filter(a => d.addOns.includes(a.key)).map(a => a.key),
    participants: d.children.map(ch => {
      const answers: Record<string, FamilyCheckoutAnswer> = {};
      for (const q of page.questions) {
        const v = d.answers[ch]?.[q.key];
        if (typeof v === 'boolean') answers[q.key] = v;
        else if (typeof v === 'string' && v.trim() !== '') answers[q.key] = v.trim();
      }
      return { studentProfileId: ch, answers };
    }),
  };
}

type Pending = { page: FamilyCheckoutPage; option: FamilyCheckoutOption };
type Status = { phase: 'form' } | { phase: 'sending' } | { phase: 'unknown' } | { phase: 'result'; tone: 'good' | 'bad' | 'warn'; message: string };

/**
 * Checkout pages (CP3, 0582): a guardian buys a one-time option of the school's checkout pages for their own children
 * and pays on the school's own processor page (TEST mode). The app sends only the page's own ids and version, children
 * it read here, answers and add-ons; the server decides the price. Closing the payment page is never shown as paid:
 * the answer shown is HON's record of the processor's answer. A lost answer keeps its key, so Try again never orders twice.
 */
export function CheckoutArea() {
  const { api, newKey } = useFamily();
  const c = useColors();
  const [read, setRead] = useState<ParentRead<ParentCheckoutPages> | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [draft, setDraft] = useState<CheckoutDraft | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [busyOrder, setBusyOrder] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const generation = useRef(0);
  const keys = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    const mine = ++generation.current;
    const result = await api.checkoutPages();
    if (mine === generation.current) setRead(result);
  }, [api]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);

  const keyFor = (action: string) => { let k = keys.current.get(action); if (!k) { k = newKey(); keys.current.set(action, k); } return k; };
  const close = () => { setPending(null); setDraft(null); setStatus(null); };
  const refused = (code: string | undefined, fallback: string) => (code && CHECKOUT_REFUSALS[code]) || fallback;

  /** After the processor page closes: HON's record of the processor's answer. */
  const confirmAfterPage = async (orderId: string): Promise<{ tone: 'good' | 'bad' | 'warn'; message: string }> => {
    const done = await api.confirmCheckoutOrder(orderId, newKey());
    if (!done.ok) return { tone: 'warn', message: "We couldn't check the payment yet. Open Checkout again in a moment to see it." };
    const s = done.data.order.status;
    if (s === 'PAID') return { tone: 'good', message: `Paid: ${done.data.order.title}. Your school has your order.` };
    if (done.data.payState === 'PROCESSING') return { tone: 'warn', message: 'Your payment is still being processed. We will show it here when it clears.' };
    if (s === 'CANCELED') return { tone: 'bad', message: 'The payment did not go through, so the order was canceled. You were not charged.' };
    return { tone: 'warn', message: 'Not paid yet. You can finish paying from Your orders.' };
  };
  const openPage = async (orderId: string, url: string) => { await WebBrowser.openBrowserAsync(url); return confirmAfterPage(orderId); };

  const send = async (p: Pending, d: CheckoutDraft) => {
    let input: OpenParentCheckoutOrderInput;
    try { input = checkoutInput(p.page, p.option, d); } catch { setStatus({ phase: 'result', tone: 'bad', message: CHECKOUT_REFUSALS.VALIDATION_FAILED! }); return; }
    const action = `order:${JSON.stringify(input)}`;
    setStatus({ phase: 'sending' });
    let result: ParentWrite<ParentCheckoutOrderStart>;
    try { result = await api.orderCheckout(input, keyFor(action)); } catch {
      keys.current.delete(action);
      setStatus({ phase: 'result', tone: 'bad', message: CHECKOUT_REFUSALS.VALIDATION_FAILED! }); return;
    }
    if (!result.ok && result.state === 'unknown') { setStatus({ phase: 'unknown' }); void load(); return; }
    keys.current.delete(action);
    if (!result.ok) {
      setStatus({ phase: 'result', tone: 'bad', message: result.state === 'refused' ? refused(result.code, 'This order was not accepted. Nothing was charged.') : 'Buying is not available on this account right now.' });
      await load(); return;
    }
    const r = result.data;
    if (r.status === 'PAID') setStatus({ phase: 'result', tone: 'good', message: r.amountMinor === 0 ? "You're signed up. Your school has your order." : `Paid: ${formatMoney(r.amountMinor, r.currency)}.` });
    else if (r.url) setStatus({ phase: 'result', ...(await openPage(r.orderId, r.url)) });
    else setStatus({ phase: 'result', tone: 'warn', message: r.payState === 'PROCESSING' ? 'Your payment is still being processed.' : 'Not paid. You can try again from Your orders.' });
    await load();
  };

  const payExisting = async (o: FamilyCheckoutOrder) => {
    setBusyOrder(o.orderId);
    const action = `start:${o.orderId}`;
    try {
      const started = await api.startCheckoutOrder(o.orderId, keyFor(action));
      if (!started.ok && started.state === 'unknown') { setNotes(n => ({ ...n, [o.orderId]: "We couldn't reach your school. Try again; you won't be charged twice." })); return; }
      keys.current.delete(action);
      if (!started.ok) { setNotes(n => ({ ...n, [o.orderId]: refused(started.code, 'Paying is unavailable right now.') })); return; }
      const out = started.data.url ? await openPage(o.orderId, started.data.url)
        : { message: started.data.status === 'PAID' ? 'Already paid.' : started.data.payState === 'PROCESSING' ? 'Your payment is still being processed.' : 'This order ended without payment. You can order again.' };
      setNotes(n => ({ ...n, [o.orderId]: out.message }));
      await load();
    } finally { setBusyOrder(null); }
  };

  if (!read) return <Loading label="Loading checkout pages" />;
  if (!read.ok) return <StateMessage title="Checkout is unavailable" body="We couldn't load this from your school right now. Nothing old is shown in its place." action={{ label: 'Try again', onPress: () => { setRead(null); void load(); } }} />;
  const v = read.data;
  const chip = (selected: boolean) => ({ minHeight: TOUCH, paddingHorizontal: space.md, justifyContent: 'center' as const, borderRadius: radius.pill, borderWidth: 1,
    borderColor: selected ? c.accent : c.border, backgroundColor: selected ? c.accent : c.surface, marginRight: space.sm, marginTop: space.sm });
  const chipText = (selected: boolean) => ({ color: selected ? c.accentText : c.text, fontWeight: '600' as const });
  const field = { marginTop: space.sm, minHeight: TOUCH, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, color: c.text, padding: space.md, fontSize: type.body } as const;
  const setAnswer = (d: CheckoutDraft, ch: string, key: string, value: FamilyCheckoutAnswer | undefined) =>
    setDraft({ ...d, answers: { ...d.answers, [ch]: { ...d.answers[ch], [key]: value } } });
  const childName = (id: string) => v.children.find(x => x.studentProfileId === id)?.displayName ?? 'Child';

  const form = pending && draft && status ? (
    <Card style={{ borderColor: c.accent, marginTop: space.md }}>
      <Text style={{ color: c.text, fontSize: type.title, fontWeight: '700' }}>{pending.page.title}: {pending.option.label}</Text>
      {status.phase === 'form' ? (
        <View>
          <Text style={{ color: c.muted, fontWeight: '700', marginTop: space.md }}>{pending.page.maxParticipants > 1 ? `Who is it for? (up to ${pending.page.maxParticipants})` : 'Who is it for?'}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {v.children.map(ch => {
              const on = draft.children.includes(ch.studentProfileId);
              return (
                <Pressable key={ch.studentProfileId} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={ch.displayName}
                  onPress={() => setDraft({ ...draft, children: on ? draft.children.filter(x => x !== ch.studentProfileId)
                    : pending.page.maxParticipants === 1 ? [ch.studentProfileId] : draft.children.length < pending.page.maxParticipants ? [...draft.children, ch.studentProfileId] : draft.children })}
                  style={chip(on)}>
                  <Text style={chipText(on)}>{on ? '✓ ' : ''}{ch.displayName}</Text>
                </Pressable>
              );
            })}
          </View>
          {draft.children.map(ch => pending.page.questions.length ? (
            <View key={ch} style={{ marginTop: space.md }}>
              <Text style={{ color: c.text, fontWeight: '700' }}>{childName(ch)}</Text>
              {pending.page.questions.map(q => {
                const value = draft.answers[ch]?.[q.key];
                return (
                  <View key={q.key} style={{ marginTop: space.sm }}>
                    <Text style={{ color: c.text, fontWeight: '600' }}>{q.label}{q.required ? '' : ' (optional)'}</Text>
                    {q.kind === 'TEXT' ? (
                      <TextInput accessibilityLabel={`${q.label} for ${childName(ch)}`} maxLength={500} value={typeof value === 'string' ? value : ''}
                        onChangeText={t => setAnswer(draft, ch, q.key, t === '' ? undefined : t)} style={field} placeholderTextColor={c.subtle} />
                    ) : q.kind === 'CHOICE' ? (
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                        {q.options.map(o => (
                          <Pressable key={o} accessibilityRole="button" accessibilityState={{ selected: value === o }} accessibilityLabel={`${q.label} for ${childName(ch)}: ${o}`}
                            onPress={() => setAnswer(draft, ch, q.key, value === o ? undefined : o)} style={chip(value === o)}>
                            <Text style={chipText(value === o)}>{o}</Text>
                          </Pressable>
                        ))}
                      </View>
                    ) : (
                      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: value === true }} accessibilityLabel={`${q.label} for ${childName(ch)}`}
                        onPress={() => setAnswer(draft, ch, q.key, value === true ? (q.required ? undefined : false) : true)} style={chip(value === true)}>
                        <Text style={chipText(value === true)}>{value === true ? '✓ Yes' : 'Yes'}</Text>
                      </Pressable>
                    )}
                  </View>
                );
              })}
            </View>
          ) : null)}
          {pending.page.addOns.length ? (
            <View style={{ marginTop: space.md }}>
              <Text style={{ color: c.muted, fontWeight: '700' }}>Add-ons</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                {pending.page.addOns.map(a => {
                  const on = draft.addOns.includes(a.key);
                  return (
                    <Pressable key={a.key} accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled: a.required }}
                      accessibilityLabel={`${a.label}, ${formatMoney(a.amountMinor, pending.page.currency)}${a.required ? ', required' : ''}`}
                      onPress={() => { if (!a.required) setDraft({ ...draft, addOns: on ? draft.addOns.filter(x => x !== a.key) : [...draft.addOns, a.key] }); }} style={chip(on)}>
                      <Text style={chipText(on)}>{on ? '✓ ' : ''}{a.label} · {formatMoney(a.amountMinor, pending.page.currency)}{a.required ? ' (required)' : ''}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ) : null}
          {pending.page.waiver ? (
            <View style={{ marginTop: space.md }}>
              <Text style={{ color: c.muted }}>{pending.page.waiver}</Text>
              <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: draft.waiverAccepted }} accessibilityLabel="I have read and accept this"
                onPress={() => setDraft({ ...draft, waiverAccepted: !draft.waiverAccepted })} style={chip(draft.waiverAccepted)}>
                <Text style={chipText(draft.waiverAccepted)}>{draft.waiverAccepted ? '✓ ' : ''}I have read and accept this</Text>
              </Pressable>
            </View>
          ) : null}
          <Text style={{ color: c.text, fontSize: type.title, fontWeight: '700', marginTop: space.md }}>
            Total {formatMoney(checkoutTotal(pending.page, pending.option, draft), pending.page.currency)}
          </Text>
          {api.sampleMode ? <Body muted>This is the sample family, so nothing is ordered or paid. With your school's account, you pay on your school's own card page.</Body> : null}
          <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md }}>
            {checkoutReady(pending.page, pending.option, draft) && !api.sampleMode
              ? <Button label={checkoutTotal(pending.page, pending.option, draft) === 0 ? 'Sign up' : 'Continue to payment'} onPress={() => void send(pending, draft)} /> : null}
            <Button kind="quiet" label="Not now" onPress={close} />
          </View>
        </View>
      ) : status.phase === 'sending' ? <Loading label="Sending to your school" />
        : status.phase === 'unknown' ? (
          <View style={{ marginTop: space.md }}>
            <Body>We could not confirm this order with your school yet. Nothing is shown as ordered until HON confirms it.</Body>
            <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md }}>
              <Button label="Try again" onPress={() => void send(pending, draft)} />
              <Button kind="quiet" label="Close" onPress={close} />
            </View>
          </View>
        ) : (
          <View style={{ marginTop: space.md }}>
            <Pill tone={status.tone} text={status.message} />
            {status.tone === 'good' && pending.page.thankYou ? <Body muted>{pending.page.thankYou}</Body> : null}
            <View style={{ marginTop: space.md }}><Button kind="quiet" label="Done" onPress={close} /></View>
          </View>
        )}
    </Card>
  ) : null;

  return (
    <View>
      <View style={{ marginTop: space.md }}><Pill tone="warn" text="Test mode: no real money moves" /></View>
      {!v.canBuy ? <Card style={{ marginTop: space.md }}><Body muted>Your access to this family lets you see these pages but not buy. A guardian on the account can buy.</Body></Card> : null}
      {form}
      {v.orders.length ? <Section>Your orders</Section> : null}
      {v.orders.map(o => (
        <Card key={o.orderId}>
          <Text style={{ color: c.text, fontSize: type.title, fontWeight: '700' }}>{o.title}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm, flexWrap: 'wrap' }}>
            <Pill tone={ORDER_STATUS[o.status].tone} text={ORDER_STATUS[o.status].label} />
            <Text style={{ color: c.muted }}>{formatMoney(o.amountMinor, o.currency)} · {o.participantCount} {o.participantCount === 1 ? 'child' : 'children'}</Text>
          </View>
          {notes[o.orderId] ? <Text accessibilityLiveRegion="polite" style={{ color: c.text, marginTop: space.sm }}>{notes[o.orderId]}</Text> : null}
          {o.status === 'OPEN' && v.canBuy && v.canPay ? <View style={{ marginTop: space.md }}>
            {busyOrder === o.orderId ? <Loading label="Opening your school's payment page" />
              : <Button label={`Pay ${formatMoney(o.amountMinor, o.currency)}`} accessibilityLabel={`Pay ${formatMoney(o.amountMinor, o.currency)} for ${o.title}`} onPress={() => { if (!busyOrder) void payExisting(o); }} />}
          </View> : null}
        </Card>
      ))}
      <Section>From {v.schoolName}</Section>
      {!v.pages.length ? <Card><Body muted>There is nothing to sign up for here right now.</Body></Card> : v.pages.map(p => (
        <Card key={p.checkoutId}>
          <Text style={{ color: c.text, fontSize: type.title, fontWeight: '700' }}>{p.title}</Text>
          {p.blocks.filter(b => b.position === 'ABOVE').map((b, i) => <Body key={`a${i}`} muted>{b.text}</Body>)}
          {p.description ? <Body muted>{p.description}</Body> : null}
          {p.options.map(o => {
            const full = o.placesLeft === 0;
            const payable = o.priceMinor === 0 || v.canPay;
            return (
              <View key={o.key} style={{ marginTop: space.md }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
                  <Text style={{ color: c.text, fontWeight: '700' }}>{o.label}</Text>
                  <Text style={{ color: c.text }}>{o.priceMinor === 0 ? 'Free' : formatMoney(o.priceMinor, p.currency)}</Text>
                  {o.mostPopular ? <Pill tone="good" text="Most popular" /> : null}
                  {o.placesLeft !== null ? <Pill text={full ? 'Full' : `${o.placesLeft} left`} /> : null}
                </View>
                {o.description ? <Body muted>{o.description}</Body> : null}
                {o.additionalParticipantMinor !== null && p.maxParticipants > 1 ? <Body muted>Each extra child {formatMoney(o.additionalParticipantMinor, p.currency)}</Body> : null}
                {!payable ? <Body muted>Your school does not take card payments in the app yet.</Body> : null}
                {v.canBuy && payable && !full && !pending && v.children.length ? <View style={{ marginTop: space.sm, alignSelf: 'flex-start' }}>
                  <Button kind="quiet" label="Choose" accessibilityLabel={`Choose ${o.label} for ${p.title}`}
                    onPress={() => { setPending({ page: p, option: o }); setDraft(emptyCheckoutDraft(p)); setStatus({ phase: 'form' }); }} />
                </View> : null}
              </View>
            );
          })}
          {p.blocks.filter(b => b.position === 'BELOW').map((b, i) => <Body key={`b${i}`} muted>{b.text}</Body>)}
        </Card>
      ))}
      <Text style={{ color: c.subtle, fontSize: type.caption, marginTop: space.sm }}>You pay on your school's own card page. HON never sees or keeps your card.</Text>
    </View>
  );
}
