import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { CONVERSATION_LIMITS, type ConversationDetail, type ConversationList, type ConversationRow } from '@hon/contracts/school-conversations';
import type { ReplyBlock, StaffApi, StaffCommandFailure, StaffFailureState, StaffSchool } from './api/client';
import { T } from './ui/theme';

/**
 * S4 Texts (docs/architecture/STAFF_MOBILE_PEOPLE_TEXTS.md): the school inbox. conversation.read lists and opens a
 * conversation; conversation.manage replies (the server's consent-gated send through the same queue the web uses).
 * Opening a conversation marks it read up to the newest message shown. A reply whose outcome is not known keeps its
 * key, so sending again cannot send it twice.
 */
type Failure = Exclude<StaffFailureState, 'signed-out'>;
type InboxState = { kind: 'loading' } | { kind: 'failed'; state: Failure } | { kind: 'ready'; inbox: ConversationList };
type OpenState = { kind: 'loading' } | { kind: 'failed'; state: Failure } | { kind: 'ready'; detail: ConversationDetail };

const NOTES: Record<Failure, string> = {
  'no-staff-access': 'Your role does not include the texts inbox at this school.',
  unavailable: 'Texts are not available right now. Try again in a moment.',
  offline: 'You are offline.',
};
const REPLY_NOTES: Record<Exclude<StaffCommandFailure, 'signed-out'> | ReplyBlock, string> = {
  CONVERSATION_NOT_LINKED: 'Link this conversation to a person on the web before replying. Nothing was sent.',
  CONVERSATION_ADDRESS_MISMATCH: 'This person’s mobile number is not this conversation’s number. Nothing was sent.',
  CONVERSATION_NO_SENDER: 'This school has no texting number yet. Nothing was sent.',
  CONVERSATION_CONSENT_REQUIRED: 'This person has not agreed to texts from the school. Nothing was sent.',
  CONVERSATION_CHANNEL_UNSUPPORTED: 'Replies on this channel are not available yet. Nothing was sent.',
  'no-staff-access': 'Your role cannot reply to texts at this school. Nothing was sent.',
  changed: 'New messages came in. Read them, then send again.',
  rejected: 'HON could not take that reply. Nothing was sent.',
  unknown: 'Not sure it went through. Tap Send again to retry safely.',
  offline: 'You are offline. Tap Send again when you are connected.',
};
const nameOf = (c: ConversationRow) => c.contactName ?? c.contactAddress;
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function Texts({ api, school, newKey, onSignedOut }: { api: StaffApi; school: StaffSchool; newKey: () => string; onSignedOut: () => void }) {
  const [inbox, setInbox] = useState<InboxState>({ kind: 'loading' });
  const [open, setOpen] = useState<string | null>(null);
  const read = useCallback(async () => {
    setInbox({ kind: 'loading' });
    const result = await api.inbox(school);
    if (result.ok) setInbox({ kind: 'ready', inbox: result.data });
    else if (result.state === 'signed-out') onSignedOut();
    else setInbox({ kind: 'failed', state: result.state });
  }, [api, school, onSignedOut]);
  useEffect(() => { if (!open) void read(); }, [read, open]);

  if (open) return <Conversation api={api} school={school} conversationId={open} newKey={newKey} onBack={() => setOpen(null)} onSignedOut={onSignedOut} />;
  if (inbox.kind === 'loading') return <ActivityIndicator accessibilityLabel="Loading texts" color={T.ink} />;
  if (inbox.kind === 'failed') {
    return (
      <View style={[s.card, s.white]}>
        <Text style={s.muted}>{NOTES[inbox.state]}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Try again" onPress={() => void read()} style={s.button}><Text style={s.buttonText}>Try again</Text></Pressable>
      </View>
    );
  }
  const { conversations, unreadConversations } = inbox.inbox;
  return (
    <View style={s.stack}>
      <Text style={s.muted}>{unreadConversations ? `${unreadConversations} unread` : 'All caught up'}</Text>
      {conversations.length === 0 ? <Text style={s.muted}>No texts yet.</Text> : null}
      {conversations.map(c => (
        <Pressable key={c.conversationId} accessibilityRole="button" accessibilityLabel={`Open conversation with ${nameOf(c)}${c.unread ? `, ${c.unread} unread` : ''}`}
          onPress={() => setOpen(c.conversationId)} style={s.row}>
          <View style={s.grow}>
            <Text style={[s.rowName, c.unread > 0 && s.bold]}>{nameOf(c)}</Text>
            {c.lastMessage ? <Text numberOfLines={1} style={s.rowMeta}>{c.lastMessage.direction === 'OUTBOUND' ? 'You: ' : ''}{c.lastMessage.preview}</Text> : null}
          </View>
          {c.unread > 0 ? <View style={s.badge}><Text style={s.badgeText}>{c.unread}</Text></View> : <Text style={s.time}>{when(c.lastMessageAt)}</Text>}
        </Pressable>
      ))}
      <Pressable accessibilityRole="button" accessibilityLabel="Refresh" onPress={() => void read()} style={[s.button, s.quiet]}><Text style={s.quietText}>Refresh</Text></Pressable>
    </View>
  );
}

function Conversation({ api, school, conversationId, newKey, onBack, onSignedOut }:
  { api: StaffApi; school: StaffSchool; conversationId: string; newKey: () => string; onBack: () => void; onSignedOut: () => void }) {
  const [state, setState] = useState<OpenState>({ kind: 'loading' });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const pending = useRef<{ body: string; key: string } | null>(null);

  const read = useCallback(async () => {
    setState({ kind: 'loading' });
    const result = await api.conversation(school, conversationId);
    if (!result.ok) {
      if (result.state === 'signed-out') onSignedOut();
      else setState({ kind: 'failed', state: result.state });
      return;
    }
    setState({ kind: 'ready', detail: result.data });
    const newest = result.data.messages.at(-1);
    // Read only up to what is on screen. A failed mark changes nothing and is tried again next time.
    if (result.data.conversation.unread > 0 && newest) void api.markRead(school, conversationId, newest.messageId);
  }, [api, school, conversationId, onSignedOut]);
  useEffect(() => { void read(); }, [read]);

  const send = async (detail: ConversationDetail) => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true); setNote(null);
    try {
      if (pending.current?.body !== body) pending.current = { body, key: newKey() };
      const result = await api.reply(school, conversationId, detail.conversation.version, body, pending.current.key);
      if (!result.ok) {
        if (result.state === 'signed-out') { onSignedOut(); return; }
        if (result.state !== 'unknown' && result.state !== 'offline') pending.current = null;
        setNote(REPLY_NOTES[result.state === 'blocked' ? result.reason : result.state]);
        if (result.state === 'changed') void read();
        return;
      }
      pending.current = null;
      setText('');
      setState({ kind: 'ready', detail: { ...detail, conversation: result.data.conversation, messages: [...detail.messages, result.data.message] } });
    } finally {
      setBusy(false);
    }
  };

  const back = <Pressable accessibilityRole="button" accessibilityLabel="Back to texts" onPress={onBack} style={s.back}><Text style={s.backText}>‹ Texts</Text></Pressable>;
  if (state.kind === 'loading') return <View style={s.stack}>{back}<ActivityIndicator accessibilityLabel="Loading conversation" color={T.ink} /></View>;
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
  const { detail } = state;
  const { conversation: c, messages, contact, canManage } = detail;
  return (
    <View style={s.stack}>
      {back}
      <View style={[s.card, s.panel]}>
        <Text style={s.panelName}>{nameOf(c)}</Text>
        <Text style={s.panelMuted}>{c.channel === 'SMS' ? 'Text' : c.channel === 'EMAIL' ? 'Email' : 'Web chat'} · {c.contactAddress}{c.status === 'CLOSED' ? ' · Closed' : ''}</Text>
      </View>
      {detail.hasOlder ? <Text style={s.muted}>Older messages are on the web.</Text> : null}
      {messages.length === 0 ? <Text style={s.muted}>No messages yet.</Text> : null}
      {messages.map(m => (
        <View key={m.messageId} style={m.author === 'CONTACT' ? s.theirs : s.mine}>
          <Text style={m.author === 'CONTACT' ? s.theirsText : s.mineText}>{m.body}</Text>
          <Text style={m.author === 'CONTACT' ? s.theirsMeta : s.mineMeta}>
            {[m.author === 'STAFF' ? m.staffName : null, when(m.at), m.mediaCount ? `${m.mediaCount} attachment${m.mediaCount > 1 ? 's' : ''} on the web` : null,
              m.delivery && m.delivery !== 'DELIVERED' && m.delivery !== 'ACCEPTED' ? m.delivery.toLowerCase() : null].filter(Boolean).join(' · ')}
          </Text>
        </View>
      ))}
      {canManage ? (
        <View style={[s.card, s.white]}>
          <TextInput accessibilityLabel={`Reply to ${nameOf(c)}`} placeholder="Write a reply" placeholderTextColor={T.muted} value={text} onChangeText={setText}
            multiline maxLength={CONVERSATION_LIMITS.bodyMax} style={s.input} />
          {c.channel === 'SMS' && contact.person?.smsConsent === 'OPTED_OUT' ? <Text style={s.alert}>This person opted out of texts.</Text> : null}
          {note ? <Text style={s.alert}>{note}</Text> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Send" disabled={busy || !text.trim()} onPress={() => void send(detail)}
            style={[s.button, (busy || !text.trim()) && s.disabled]}>
            {busy ? <ActivityIndicator accessibilityLabel="Sending" color={T.pillText} /> : <Text style={s.buttonText}>Send</Text>}
          </Pressable>
        </View>
      ) : <Text style={s.muted}>Your role can read texts here but not reply.</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  stack: { gap: 12 },
  grow: { flex: 1, gap: 2 },
  card: { borderRadius: T.radius.card, padding: 20, gap: 12 },
  white: { backgroundColor: T.card, borderWidth: 1, borderColor: T.line },
  panel: { backgroundColor: T.panel },
  panelName: { color: T.panelText, fontFamily: T.serif, fontSize: 26, lineHeight: 32 },
  panelMuted: { color: T.panelMuted, fontSize: 14 },
  muted: { color: T.muted, fontSize: 15, lineHeight: 21 },
  alert: { color: T.alert, fontSize: 14, lineHeight: 20 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: T.card, borderWidth: 1, borderColor: T.line, borderRadius: 18, paddingVertical: 14, paddingHorizontal: 16 },
  rowName: { color: T.ink, fontSize: 17 },
  bold: { fontWeight: '700' },
  rowMeta: { color: T.muted, fontSize: 14 },
  time: { color: T.muted, fontSize: 12 },
  badge: { minWidth: 26, height: 26, borderRadius: 13, backgroundColor: T.orbit.coral, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 7 },
  badgeText: { color: T.ink, fontSize: 13, fontWeight: '700' },
  theirs: { alignSelf: 'flex-start', maxWidth: '85%', backgroundColor: T.card, borderWidth: 1, borderColor: T.line, borderRadius: 18, paddingVertical: 10, paddingHorizontal: 14, gap: 4 },
  theirsText: { color: T.ink, fontSize: 16, lineHeight: 22 },
  theirsMeta: { color: T.muted, fontSize: 12 },
  mine: { alignSelf: 'flex-end', maxWidth: '85%', backgroundColor: T.pill, borderRadius: 18, paddingVertical: 10, paddingHorizontal: 14, gap: 4 },
  mineText: { color: T.pillText, fontSize: 16, lineHeight: 22 },
  mineMeta: { color: T.panelMuted, fontSize: 12 },
  input: { minHeight: 70, color: T.ink, fontSize: 16, lineHeight: 22, backgroundColor: T.soft, borderRadius: 16, padding: 14, textAlignVertical: 'top' },
  button: { backgroundColor: T.pill, borderRadius: T.radius.pill, paddingVertical: 14, alignItems: 'center' },
  buttonText: { color: T.pillText, fontSize: 16, fontWeight: '700' },
  quiet: { backgroundColor: T.card, borderWidth: 1, borderColor: T.line },
  quietText: { color: T.ink, fontSize: 16, fontWeight: '700' },
  disabled: { opacity: 0.5 },
  back: { alignSelf: 'flex-start', paddingVertical: 6 },
  backText: { color: T.ink, fontSize: 16, fontWeight: '700' },
});
