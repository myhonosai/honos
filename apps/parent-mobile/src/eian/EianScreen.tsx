import React, { useMemo, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFamily } from '../family/family-data';
import { FamilyGate } from '../screens/FamilyStates';
import { Button } from '../ui/parts';
import { radius, space, TOUCH, type, useColors } from '../ui/theme';
import { answer, classify, NEEDS, SUGGESTIONS, type EianAnswer, type EianFacts, type EianTab } from './eian-engine';
import { EIAN_STYLES, eianImage, STYLE_LABEL, type EianMood, type EianStyle } from './avatar';

type Turn = { id: number; question: string; reply: EianAnswer };
const TILES: { icon: string; label: string; question: string }[] = [
  { icon: '▦', label: 'Class Schedule', question: "What's on this week?" },
  { icon: '★', label: 'Belt Testing', question: 'When is the next belt test?' },
  { icon: '▭', label: 'Invoices', question: 'Do we have any open invoices?' },
  { icon: '✉', label: 'School Messages', question: 'What did the school say?' },
];

function greeting(now: Date, timeZone: string | null): string {
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) }).format(now));
  return hour < 12 ? 'Good morning!' : hour < 18 ? 'Good afternoon!' : 'Good evening!';
}

/**
 * Eian (guided mode), laid out like the owner's reference: Eian's portrait and speech bubble, four quick tiles, then
 * "ask a question". Every answer is built from records the parent's own session reads at that moment; Eian never
 * books, sends or pays, and offers the normal screen instead, where the parent confirms.
 */
export function EianScreen({ onNavigate, initialStyle = 'chibi' }: { onNavigate: (tab: EianTab) => void; initialStyle?: EianStyle }) {
  const { api, now, state } = useFamily();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [mood, setMood] = useState<EianMood>('ready');
  const [busy, setBusy] = useState(false);
  const [style, setStyle] = useState<EianStyle>(initialStyle);
  const counter = useRef(0);

  const opener = useMemo(() => {
    if (state.status !== 'ready') return null;
    const next = answer('next class', { journey: state.view, timeZone: state.timeZone, now: now() });
    return { intent: 'next-class', lines: [greeting(now(), state.timeZone), ...next.lines], source: next.source, action: next.action } as EianAnswer;
  }, [state, now]);

  const ask = async (question: string) => {
    const q = question.trim().slice(0, 300);
    if (!q || busy || state.status !== 'ready') return;
    setDraft('');
    setBusy(true);
    const needs = NEEDS[classify(q)];
    setMood(needs.length ? 'working' : 'thinking');
    const facts: EianFacts = { journey: state.view, timeZone: state.timeZone, now: now() };
    if (needs.includes('billing')) { const r = await api.billing(); facts.billing = r.ok ? r.data : null; }
    if (needs.includes('testing')) { const r = await api.testingStatus(); facts.testing = r.ok ? r.data : null; }
    if (needs.includes('messages')) { const r = await api.schoolMessages(); facts.messages = r.ok ? r.data : null; }
    const reply = answer(q, facts);
    setTurns(t => [...t.slice(-9), { id: ++counter.current, question: q, reply }]);
    setMood('speaking');
    setBusy(false);
  };

  if (state.status !== 'ready') {
    return <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={{ padding: space.lg, paddingTop: insets.top + space.lg }}><FamilyGate state={state} /></ScrollView>;
  }
  const latest = turns[turns.length - 1];
  const speech = latest?.reply ?? opener!;

  return (
    <ScrollView style={{ backgroundColor: c.bg }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.lg, paddingTop: insets.top + space.md, paddingBottom: space.xxl }}>
      <View style={{ alignItems: 'center' }}>
        <Text accessibilityRole="header" style={{ color: c.text, fontSize: type.title, fontWeight: '800', letterSpacing: 1 }}>EIAN</Text>
        <Text style={{ color: c.muted, fontSize: type.caption }}>Your Family Assistant</Text>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginTop: space.lg, gap: space.md }}>
        <View accessible accessibilityLabel={`Eian, ${busy ? (mood === 'working' ? 'checking your records' : 'thinking') : 'ready'}`}
          style={{ width: 104, height: 104, borderRadius: 52, overflow: 'hidden', borderWidth: 3, borderColor: c.accentSoft, backgroundColor: c.surfaceAlt }}>
          <Image source={eianImage(style, busy ? mood : latest ? 'speaking' : 'ready')} style={{ width: 104, height: 154 }} resizeMode="cover" />
        </View>
        <View accessibilityLiveRegion="polite" style={{ flex: 1, backgroundColor: c.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: c.border, padding: space.md }}>
          {busy ? <Text style={{ color: c.muted, fontSize: type.body }}>{mood === 'working' ? 'Checking your school records…' : 'Thinking…'}</Text> : (
            <View accessible accessibilityLabel={`Eian says: ${speech.lines.join(' ')}`}>
              {speech.lines.map((line, i) => <Text key={i} style={{ color: c.text, fontSize: type.body, lineHeight: 22, fontWeight: i === 0 && !latest ? '700' : '400', marginTop: i ? space.xs : 0 }}>{line}</Text>)}
              {speech.source ? <Text style={{ color: c.subtle, fontSize: type.caption, marginTop: space.sm }}>From: {speech.source}</Text> : null}
              {speech.action ? <View style={{ marginTop: space.md, alignSelf: 'flex-start' }}><Button kind="quiet" label={speech.action.label} onPress={() => onNavigate(speech.action!.tab)} /></View> : null}
            </View>
          )}
        </View>
      </View>

      <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.lg }}>
        {TILES.map(t => (
          <Pressable key={t.label} accessibilityRole="button" accessibilityLabel={t.label} onPress={() => void ask(t.question)}
            style={({ pressed }) => ({ flex: 1, minHeight: 84, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface,
              alignItems: 'center', justifyContent: 'center', padding: space.xs, opacity: pressed ? 0.8 : 1 })}>
            <Text style={{ color: c.accent, fontSize: 24 }}>{t.icon}</Text>
            <Text maxFontSizeMultiplier={1.2} style={{ color: c.text, fontSize: type.caption - 1, fontWeight: '600', textAlign: 'center', marginTop: space.xs }}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.lg, alignItems: 'center' }}>
        <TextInput accessibilityLabel="Ask Eian" value={draft} onChangeText={setDraft} maxLength={300} placeholder="Ask a question" placeholderTextColor={c.subtle}
          onSubmitEditing={() => void ask(draft)} returnKeyType="send" editable={!busy}
          style={{ flex: 1, minHeight: TOUCH, borderRadius: radius.pill, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, color: c.text, paddingHorizontal: space.lg, fontSize: type.body }} />
        <Button label="Ask" accessibilityLabel="Send question to Eian" onPress={() => void ask(draft)} />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md }}>
        {SUGGESTIONS.filter(s => !TILES.some(t => t.question === s)).map(s => (
          <Pressable key={s} accessibilityRole="button" accessibilityLabel={`Ask Eian: ${s}`} onPress={() => void ask(s)}
            style={{ minHeight: 40, justifyContent: 'center', paddingHorizontal: space.md, borderRadius: radius.pill, backgroundColor: c.surfaceAlt }}>
            <Text style={{ color: c.text, fontSize: type.caption }}>{s}</Text>
          </Pressable>
        ))}
      </View>

      {turns.length > 1 ? (
        <View style={{ marginTop: space.xl }}>
          <Text style={{ color: c.muted, fontWeight: '700', marginBottom: space.sm }}>Earlier</Text>
          {turns.slice(0, -1).reverse().map(turn => (
            <View key={turn.id} style={{ marginBottom: space.md }}>
              <Text style={{ color: c.accent, fontWeight: '700' }}>{turn.question}</Text>
              {turn.reply.lines.map((line, i) => <Text key={i} style={{ color: c.muted, marginTop: 2 }}>{line}</Text>)}
            </View>
          ))}
        </View>
      ) : null}

      <Text style={{ color: c.muted, fontWeight: '700', marginTop: space.xl, marginBottom: space.sm }}>Eian's look</Text>
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        {EIAN_STYLES.map(s => (
          <Pressable key={s} accessibilityRole="button" accessibilityLabel={`Eian look: ${STYLE_LABEL[s]}`} accessibilityState={{ selected: s === style }} onPress={() => setStyle(s)}
            style={{ flex: 1, alignItems: 'center', padding: space.xs, borderRadius: radius.md, borderWidth: 2, borderColor: s === style ? c.accent : 'transparent' }}>
            <Image source={eianImage(s, 'ready')} style={{ width: 56, height: 56, borderRadius: 28 }} resizeMode="cover" />
            <Text style={{ color: c.text, fontSize: type.caption - 2, marginTop: 2, textAlign: 'center' }}>{STYLE_LABEL[s]}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={{ color: c.subtle, fontSize: type.caption, marginTop: space.lg }}>Eian understands common family questions and answers only from your school's records. It does not use an outside AI service and never pays, books or sends anything by itself.</Text>
    </ScrollView>
  );
}
