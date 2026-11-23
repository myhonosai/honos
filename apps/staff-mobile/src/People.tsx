import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { SchoolContactRow } from '@hon/contracts/school-contacts';
import type { SchoolContactCard } from '@hon/contracts/school-contact-card';
import { CONTACT_SEARCH_MAX, type ContactSearch, type StaffApi, type StaffFailureState, type StaffSchool } from './api/client';
import { T } from './ui/theme';

/**
 * S4 People (docs/architecture/STAFF_MOBILE_PEOPLE_TEXTS.md): search the school's contacts and open a short card.
 * The server decides everything shown: people.read for the list and card, and each card section's own permission
 * (a section the role does not include comes back not allowed and is left out). Call and Text hand the number to the
 * phone's own apps; HON sends nothing from here.
 */
type Failure = Exclude<StaffFailureState, 'signed-out'>;
type ListState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'failed'; state: Failure } | { kind: 'ready'; search: string; result: ContactSearch };
type CardState = { kind: 'loading' } | { kind: 'failed'; state: Failure } | { kind: 'ready'; card: SchoolContactCard };

const NOTES: Record<Failure, string> = {
  'no-staff-access': 'Your role does not include contacts at this school.',
  unavailable: 'Contacts are not available right now. Try again in a moment.',
  offline: 'You are offline.',
};
export const SEGMENT_LABEL: Record<SchoolContactRow['segment'], string> = {
  STUDENT: 'Student', TRIAL: 'Trial', PROSPECT: 'Prospect', INACTIVE: 'Inactive', ARCHIVED: 'Archived', OTHER: 'Contact',
};
const fullName = (p: { givenName: string; familyName: string }) => `${p.givenName} ${p.familyName}`.trim();
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const money = (minor: number, currency: string) => {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100); } catch { return `${(minor / 100).toFixed(2)} ${currency}`; }
};

export function People({ api, school, onSignedOut }: { api: StaffApi; school: StaffSchool; onSignedOut: () => void }) {
  const [text, setText] = useState('');
  const [list, setList] = useState<ListState>({ kind: 'idle' });
  const [open, setOpen] = useState<string | null>(null);
  const asked = useRef(0);

  const search = useCallback(async () => {
    const q = text.trim();
    if (!q) return;
    const ticket = ++asked.current;
    setList({ kind: 'loading' });
    const result = await api.findContacts(school, q);
    if (ticket !== asked.current) return;
    if (result.ok) setList({ kind: 'ready', search: q, result: result.data });
    else if (result.state === 'signed-out') onSignedOut();
    else setList({ kind: 'failed', state: result.state });
  }, [api, school, text, onSignedOut]);

  if (open) return <ContactCard api={api} school={school} personId={open} onBack={() => setOpen(null)} onSignedOut={onSignedOut} />;
  return (
    <View style={s.stack}>
      <View style={[s.card, s.white]}>
        <TextInput accessibilityLabel="Search contacts" placeholder="Name, phone or email" placeholderTextColor={T.muted} value={text} onChangeText={setText}
          onSubmitEditing={() => void search()} returnKeyType="search" maxLength={CONTACT_SEARCH_MAX} autoCorrect={false} style={s.input} />
        <Pressable accessibilityRole="button" accessibilityLabel="Search" disabled={!text.trim()} onPress={() => void search()} style={[s.button, !text.trim() && s.disabled]}>
          <Text style={s.buttonText}>Search</Text>
        </Pressable>
      </View>
      {list.kind === 'loading' ? <ActivityIndicator accessibilityLabel="Searching" color={T.ink} /> : null}
      {list.kind === 'failed' ? <Text style={s.alert}>{NOTES[list.state]}</Text> : null}
      {list.kind === 'ready' && list.result.rows.length === 0 ? <Text style={s.muted}>No contacts match “{list.search}”.</Text> : null}
      {list.kind === 'ready' ? list.result.rows.map(row => (
        <Pressable key={row.personId} accessibilityRole="button" accessibilityLabel={`Open ${fullName(row)}`} onPress={() => setOpen(row.personId)} style={s.row}>
          <View style={s.grow}>
            <Text style={s.rowName}>{fullName(row)}</Text>
            <Text style={s.rowMeta}>{[SEGMENT_LABEL[row.segment], row.planName, row.ranks[0]?.rank].filter(Boolean).join(' · ')}</Text>
          </View>
          <Text style={s.arrow}>›</Text>
        </Pressable>
      )) : null}
      {list.kind === 'ready' && list.result.hasMore ? <Text style={s.muted}>Showing the first matches. Type more of the name to narrow it down.</Text> : null}
    </View>
  );
}

function ContactCard({ api, school, personId, onBack, onSignedOut }: { api: StaffApi; school: StaffSchool; personId: string; onBack: () => void; onSignedOut: () => void }) {
  const [state, setState] = useState<CardState>({ kind: 'loading' });
  const read = useCallback(async () => {
    setState({ kind: 'loading' });
    const result = await api.contactCard(school, personId);
    if (result.ok) setState({ kind: 'ready', card: result.data });
    else if (result.state === 'signed-out') onSignedOut();
    else setState({ kind: 'failed', state: result.state });
  }, [api, school, personId, onSignedOut]);
  useEffect(() => { void read(); }, [read]);

  const back = (
    <Pressable accessibilityRole="button" accessibilityLabel="Back to search" onPress={onBack} style={s.back}><Text style={s.backText}>‹ Search</Text></Pressable>
  );
  if (state.kind === 'loading') return <View style={s.stack}>{back}<ActivityIndicator accessibilityLabel="Loading contact" color={T.ink} /></View>;
  if (state.kind === 'failed') {
    return (
      <View style={s.stack}>{back}
        <View style={[s.card, s.white]}>
          <Text style={s.muted}>{NOTES[state.state]}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Try again" onPress={() => void read()} style={s.button}><Text style={s.buttonText}>Try again</Text></Pressable>
        </View>
      </View>
    );
  }
  const { person, overview, membership, family, billing, timeline } = state.card;
  const lastAttendance = timeline.filter(t => t.kind === 'ATTENDANCE').map(t => t.at).sort().at(-1) ?? null;
  const phone = person.phoneE164;
  return (
    <View style={s.stack}>
      {back}
      <View style={[s.card, s.panel]}>
        <Text style={s.panelName}>{fullName(person)}</Text>
        <Text style={s.panelMuted}>{[SEGMENT_LABEL[overview.segment], overview.programName, overview.planName].filter(Boolean).join(' · ')}</Text>
        {overview.ranks.length ? <Text style={s.panelText}>{overview.ranks.map(r => `${r.rank} (${r.curriculum})`).join(', ')}</Text> : null}
        {phone ? (
          <View style={s.actions}>
            <Pressable accessibilityRole="button" accessibilityLabel={`Call ${person.givenName}`} onPress={() => void Linking.openURL(`tel:${phone}`)} style={s.action}><Text style={s.actionText}>Call</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={`Text ${person.givenName}`} onPress={() => void Linking.openURL(`sms:${phone}`)} style={s.action}><Text style={s.actionText}>Text</Text></Pressable>
          </View>
        ) : null}
      </View>
      <View style={[s.card, s.white]}>
        <Line label="Phone" value={phone} />
        <Line label="Email" value={person.email} />
        <Line label="Membership ends" value={overview.membershipEndsAt ? day(overview.membershipEndsAt) : null} />
        <Line label="Last class" value={lastAttendance ? day(lastAttendance) : 'No class recorded'} />
        {overview.openLead ? <Text style={s.muted}>Has an open lead.</Text> : null}
      </View>
      {membership.allowed && membership.items.length ? (
        <View style={[s.card, s.white]}>
          <Text style={s.section}>Memberships</Text>
          {membership.items.map(m => <Line key={m.membershipId} label={m.planName ?? m.planCode} value={`${m.state.toLowerCase()}${m.endsAt ? `, ends ${day(m.endsAt)}` : ''}`} />)}
        </View>
      ) : null}
      {family.allowed && family.families.length ? (
        <View style={[s.card, s.white]}>
          <Text style={s.section}>Family</Text>
          {family.families.map(f => <Line key={f.familyId} label={f.name} value={f.members.filter(m => m.personId !== person.personId).map(fullName).join(', ') || null} />)}
        </View>
      ) : null}
      {billing.allowed && billing.open.length ? (
        <View style={[s.card, s.white]}>
          <Text style={s.section}>Balance due</Text>
          {billing.open.map(o => <Text key={o.currency} style={s.value}>{money(o.dueMinor, o.currency)}</Text>)}
        </View>
      ) : null}
    </View>
  );
}

function Line({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <View style={s.line}>
      <Text style={s.label}>{label}</Text>
      <Text style={s.value}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  stack: { gap: 12 },
  grow: { flex: 1, gap: 2 },
  card: { borderRadius: T.radius.card, padding: 20, gap: 12 },
  white: { backgroundColor: T.card, borderWidth: 1, borderColor: T.line },
  panel: { backgroundColor: T.panel },
  panelName: { color: T.panelText, fontFamily: T.serif, fontSize: 28, lineHeight: 34 },
  panelText: { color: T.panelText, fontSize: 15 },
  panelMuted: { color: T.panelMuted, fontSize: 15 },
  actions: { flexDirection: 'row', gap: 10 },
  action: { flex: 1, backgroundColor: T.orbit.lime, borderRadius: T.radius.pill, paddingVertical: 12, alignItems: 'center' },
  actionText: { color: T.ink, fontSize: 16, fontWeight: '700' },
  section: { color: T.muted, fontSize: 13, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
  line: { gap: 2 },
  label: { color: T.muted, fontSize: 13 },
  value: { color: T.ink, fontSize: 16 },
  muted: { color: T.muted, fontSize: 15, lineHeight: 21 },
  alert: { color: T.alert, fontSize: 15 },
  input: { color: T.ink, fontSize: 16, backgroundColor: T.soft, borderRadius: 16, paddingVertical: 14, paddingHorizontal: 16 },
  button: { backgroundColor: T.pill, borderRadius: T.radius.pill, paddingVertical: 14, alignItems: 'center' },
  buttonText: { color: T.pillText, fontSize: 16, fontWeight: '700' },
  disabled: { opacity: 0.5 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: T.card, borderWidth: 1, borderColor: T.line, borderRadius: 18, paddingVertical: 14, paddingHorizontal: 16 },
  rowName: { color: T.ink, fontSize: 17, fontWeight: '600' },
  rowMeta: { color: T.muted, fontSize: 14 },
  arrow: { color: T.muted, fontSize: 24 },
  back: { alignSelf: 'flex-start', paddingVertical: 6 },
  backText: { color: T.ink, fontSize: 16, fontWeight: '700' },
});
