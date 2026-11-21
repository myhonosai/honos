import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, TextInput, View } from 'react-native';
import { Text } from '../ui/text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFamily } from '../family/family-data';
import { FamilyGate } from '../screens/FamilyStates';
import { Button } from '../ui/parts';
import { radius, space, TOUCH, type, useColors } from '../ui/theme';
import { answer, classify, NEEDS, SUGGESTIONS, type EianAnswer, type EianFacts, type EianTab } from './eian-engine';
import { askEianAi } from './eian-ai';
import { EianVoiceContext, spokenText, VOICE_NOTE } from './voice';
import { EIAN_STYLES, eianImage, STYLE_LABEL, type EianMood, type EianStyle } from './avatar';

type Turn = { id: number; question: string; reply: EianAnswer };
const TILES: { icon: string; label: string; question: string }[] = [
  { icon: '▦', label: 'Schedule', question: "What's on this week?" },
  { icon: '★', label: 'Belt Testing', question: 'When is the next belt test?' },
  { icon: '▭', label: 'Invoices', question: 'Do we have any open invoices?' },
  { icon: '✉', label: 'Messages', question: 'What did the school say?' },
];

function greeting(now: Date, timeZone: string | null): string {
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) }).format(now));
  return hour < 12 ? 'Good morning!' : hour < 18 ? 'Good afternoon!' : 'Good evening!';
}

/**
 * Eian, laid out like the owner's reference: Eian's portrait and speech bubble, four quick tiles, then
 * "ask a question". Every answer is built from records the parent's own session reads at that moment; Eian never
 * books, sends or pays, and offers the normal screen instead, where the parent confirms. When HON says AI is on for this school, a question
 * the guided engine does not recognize goes to Eian AI (answered from the family's own records on the server); guided
 * answers stay on the device. `focusTick` changes each time the tab gains focus, so the AI status is read again.
 *
 * Voice (when the phone supplies it): the microphone hears one question per tap and asks it exactly like a typed one;
 * an answer to a spoken question is read aloud, and any answer can be read aloud on request. Leaving the screen stops
 * both. `active` is false while another tab is showing.
 */
export function EianScreen({ onNavigate, initialStyle = 'chibi', focusTick = 0, active = true }: { onNavigate: (tab: EianTab) => void; initialStyle?: EianStyle; focusTick?: number; active?: boolean }) {
  const { api, now, state, newKey } = useFamily();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [mood, setMood] = useState<EianMood>('ready');
  const [busy, setBusy] = useState(false);
  const [style, setStyle] = useState<EianStyle>(initialStyle);
  const counter = useRef(0);
  const [ai, setAi] = useState(false);
  /** The key of a question whose outcome is not known yet: the same question re-asks with it, never a fresh key. */
  const pending = useRef<{ question: string; key: string } | null>(null);
  const ready = state.status === 'ready';
  const voice = useContext(EianVoiceContext);
  const [listening, setListening] = useState(false);
  const [reading, setReading] = useState(false);
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const hearing = useRef<{ stop(): void; cancel(): void } | null>(null);
  const canListen = useMemo(() => Boolean(voice?.canListen()), [voice]);

  const quiet = () => { voice?.stopSpeaking(); setReading(false); };
  const read = (reply: EianAnswer) => {
    if (!voice) return;
    setReading(true);
    voice.speak(spokenText(reply), () => setReading(false));
  };
  // Nothing keeps listening or talking once the parent leaves Eian or signs out.
  useEffect(() => {
    if (active && ready) return;
    hearing.current?.cancel(); hearing.current = null; setListening(false);
    voice?.stopSpeaking(); setReading(false);
  }, [active, ready, voice]);
  useEffect(() => () => { hearing.current?.cancel(); voice?.stopSpeaking(); }, [voice]);

  useEffect(() => {
    if (!ready) { setAi(false); return; }
    let live = true;
    void api.eianStatus().then(r => { if (live) setAi(r.ok && r.data.mode === 'AI'); });
    return () => { live = false; };
  }, [api, ready, focusTick]);

  const opener = useMemo(() => {
    if (state.status !== 'ready') return null;
    const next = answer('next class', { journey: state.view, timeZone: state.timeZone, now: now() });
    return { intent: 'next-class', lines: [greeting(now(), state.timeZone), ...next.lines], source: next.source, action: next.action } as EianAnswer;
  }, [state, now]);

  const ask = async (question: string, spoken = false) => {
    const q = question.trim().slice(0, 300);
    if (!q || busy || state.status !== 'ready') return;
    setDraft('');
    setVoiceNote(null);
    quiet();
    setBusy(true);
    const intent = classify(q);
    if (intent === 'help' && ai) {
      setMood('thinking');
      const key = pending.current?.question === q ? pending.current.key : newKey();
      const outcome = await askEianAi(api, q, key);
      pending.current = outcome.kind === 'answer' && outcome.reuseKey ? { question: q, key } : null;
      if (outcome.kind === 'answer') {
        setTurns(t => [...t.slice(-9), { id: ++counter.current, question: q, reply: outcome.answer }]);
        setMood('speaking');
        setBusy(false);
        if (spoken) read(outcome.answer);
        return;
      }
      if (outcome.aiOff) setAi(false);
    }
    const needs = NEEDS[intent];
    setMood(needs.length ? 'working' : 'thinking');
    const facts: EianFacts = { journey: state.view, timeZone: state.timeZone, now: now() };
    if (needs.includes('billing')) { const r = await api.billing(); facts.billing = r.ok ? r.data : null; }
    if (needs.includes('testing')) { const r = await api.testingStatus(); facts.testing = r.ok ? r.data : null; }
    if (needs.includes('messages')) { const r = await api.schoolMessages(); facts.messages = r.ok ? r.data : null; }
    const reply = answer(q, facts);
    setTurns(t => [...t.slice(-9), { id: ++counter.current, question: q, reply }]);
    setMood('speaking');
    setBusy(false);
    if (spoken) read(reply);
  };

  const listen = () => {
    if (!voice || busy) return;
    if (hearing.current) { hearing.current.stop(); return; }
    quiet();
    setVoiceNote(null);
    setDraft('');
    setListening(true);
    hearing.current = voice.listen({
      partial: text => setDraft(text.slice(0, 300)),
      end: result => {
        hearing.current = null;
        setListening(false);
        if (result.kind === 'heard') void ask(result.text, true);
        else { setDraft(''); setVoiceNote(VOICE_NOTE[result.kind]); }
      },
    });
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

      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: space.lg }}>
        <View accessible accessibilityLabel={`Eian, ${busy ? (mood === 'working' ? 'checking your records' : 'thinking') : 'ready'}`}
          style={{ width: 104, height: 104, borderRadius: 52, overflow: 'hidden', borderWidth: 3, borderColor: c.accentSoft, backgroundColor: c.surfaceAlt }}>
          <Image source={eianImage(style, busy ? mood : latest ? 'speaking' : 'ready')} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
        </View>
        {/* Speech-bubble tail pointing at Eian, so the bubble reads as Eian talking. */}
        <View style={{ width: 0, height: 0, marginLeft: space.sm, borderTopWidth: 9, borderBottomWidth: 9, borderRightWidth: 11, borderTopColor: 'transparent', borderBottomColor: 'transparent', borderRightColor: c.border }} />
        <View accessibilityLiveRegion="polite" style={{ flex: 1, minHeight: 104, justifyContent: 'center', backgroundColor: c.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: c.border, padding: space.md }}>
          {busy ? <Text style={{ color: c.muted, fontSize: type.body }}>{mood === 'working' ? 'Checking your school records…' : ai ? 'Thinking… this can take a few seconds.' : 'Thinking…'}</Text> : (
            <View accessible accessibilityLabel={`Eian says: ${speech.lines.join(' ')}`}>
              {speech.lines.map((line, i) => <Text key={i} style={{ color: c.text, fontSize: type.body, lineHeight: 22, fontWeight: i === 0 && !latest ? '700' : '400', marginTop: i ? space.xs : 0 }}>{line}</Text>)}
              {speech.source ? <Text style={{ color: c.subtle, fontSize: type.caption, marginTop: space.sm }}>From: {speech.source}</Text> : null}
              {speech.action ? <View style={{ marginTop: space.md, alignSelf: 'flex-start' }}><Button kind="quiet" label={speech.action.label} onPress={() => onNavigate(speech.action!.tab)} /></View> : null}
              {voice ? (
                <Pressable accessibilityRole="button" accessibilityLabel={reading ? 'Stop reading aloud' : "Read Eian's answer aloud"} onPress={() => (reading ? quiet() : read(speech))} hitSlop={8}
                  style={{ alignSelf: 'flex-start', minHeight: 40, justifyContent: 'center', marginTop: space.sm }}>
                  <Text style={{ color: c.accent, fontSize: type.caption, fontWeight: '700' }}>{reading ? '■ Stop' : '▶ Read aloud'}</Text>
                </Pressable>
              ) : null}
            </View>
          )}
        </View>
      </View>

      <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.lg }}>
        {TILES.map(t => (
          <Pressable key={t.label} accessibilityRole="button" accessibilityLabel={t.label} onPress={() => void ask(t.question)}
            style={({ pressed }) => ({ flex: 1, minWidth: 0, height: 80, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface,
              alignItems: 'center', justifyContent: 'center', paddingHorizontal: 2, opacity: pressed ? 0.8 : 1 })}>
            {/* Fixed icon and label slots keep every tile's icon and text on the same lines. */}
            <View style={{ height: 30, justifyContent: 'center' }}><Text style={{ color: c.accent, fontSize: 24, lineHeight: 30 }}>{t.icon}</Text></View>
            <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} maxFontSizeMultiplier={1.2}
              style={{ color: c.text, fontSize: type.caption - 1, lineHeight: 18, fontWeight: '600', textAlign: 'center', marginTop: space.xs }}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.lg, alignItems: 'center' }}>
        <TextInput accessibilityLabel="Ask Eian" value={draft} onChangeText={setDraft} maxLength={300} placeholder={listening ? 'Listening…' : 'Ask a question'} placeholderTextColor={c.subtle}
          onSubmitEditing={() => void ask(draft)} returnKeyType="send" editable={!busy && !listening}
          style={{ flex: 1, minWidth: 0, minHeight: TOUCH, borderRadius: radius.pill, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, color: c.text, paddingHorizontal: space.lg, fontSize: type.body }} />
        {canListen ? (
          <Pressable accessibilityRole="button" accessibilityLabel={listening ? 'Stop listening' : 'Ask Eian by voice'} accessibilityState={{ selected: listening, disabled: busy }} disabled={busy} onPress={listen}
            style={({ pressed }) => ({ width: TOUCH, height: TOUCH, borderRadius: TOUCH / 2, alignItems: 'center', justifyContent: 'center', borderWidth: 2,
              borderColor: listening ? c.accent : c.border, backgroundColor: listening ? c.accentSoft : c.surface, opacity: busy ? 0.5 : pressed ? 0.8 : 1 })}>
            <Text style={{ color: c.accent, fontSize: 20, lineHeight: 24, fontWeight: '800' }}>{listening ? '■' : '🎤'}</Text>
          </Pressable>
        ) : null}
        <Button label="Ask" accessibilityLabel="Send question to Eian" onPress={() => void ask(draft)} />
      </View>
      {voiceNote ? <Text accessibilityLiveRegion="polite" style={{ color: c.muted, fontSize: type.caption, marginTop: space.sm }}>{voiceNote}</Text> : null}
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
      <Text style={{ color: c.subtle, fontSize: type.caption, marginTop: space.lg }}>{ai
        ? "Eian answers common family questions on your phone. Other questions are answered by AI from your school's records, and those answers are marked AI. Eian never pays, books or sends anything by itself."
        : "Eian understands common family questions and answers only from your school's records. It never pays, books or sends anything by itself."}</Text>
      {voice ? <Text style={{ color: c.subtle, fontSize: type.caption, marginTop: space.sm }}>{canListen
        ? "Voice uses your phone's own voice and speech service. The microphone is on only after you tap it, for one question at a time."
        : "Reading aloud uses your phone's own voice."}</Text> : null}
    </ScrollView>
  );
}
