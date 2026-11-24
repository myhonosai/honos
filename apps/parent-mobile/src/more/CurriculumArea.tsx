import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import type { CurriculumAppEntry, CurriculumAppItem, ParentCurriculumApp } from '@hon/contracts/parent-app-curriculum';
import type { ParentRead } from '../api/client';
import { useFamily } from '../family/family-data';
import { Text } from '../ui/text';
import { Body, Button, Card, Loading, Section, StateMessage } from '../ui/parts';
import { space, type, useColors } from '../ui/theme';
import { KIND_TEXT, SECTION_PREVIEW, hasMaterial, nextLine, nowLine, sectionTitle } from './curriculum-model';

/**
 * More > Curriculum (docs/architecture/PARENT_APP_CURRICULUM.md section 8). For each child and each curriculum the school shows in
 * the app: the child's current rank or the cycle being taught now, and the videos, documents and links the school shared for it.
 * One verified read; a failure replaces the data and never shows something old. Links open only when they are https.
 */
export function CurriculumArea() {
  const { api } = useFamily();
  const [read, setRead] = useState<ParentRead<ParentCurriculumApp> | null>(null);
  const generation = useRef(0);
  const reload = useCallback(() => {
    const mine = ++generation.current;
    setRead(null);
    void api.curriculumApp().then(r => { if (mine === generation.current) setRead(r); });
  }, [api]);
  useEffect(() => { reload(); return () => { generation.current++; }; }, [reload]);

  if (!read) return <Loading label="Loading the curriculum" />;
  if (!read.ok) return <StateMessage title="The curriculum is unavailable" body="We couldn't load this from your school right now. Nothing old is shown in its place." action={{ label: 'Try again', onPress: reload }} />;
  const children = read.data.children.filter(child => child.curricula.length > 0);
  if (!children.length) return <Card style={{ marginTop: space.lg }}><Body muted>Your school has not shared a curriculum in the app yet.</Body></Card>;
  return (
    <View style={{ marginTop: space.sm }}>
      {children.map((child, i) => (
        <View key={`child-${i}`}>
          {children.length > 1 || read.data.children.length > 1 ? <Section>{child.childDisplayName}</Section> : <View style={{ height: space.lg }} />}
          {child.curricula.map((entry, j) => <CurriculumCard key={`c-${i}-${j}`} child={child.childDisplayName} entry={entry} />)}
        </View>
      ))}
    </View>
  );
}

function CurriculumCard({ child, entry }: { child: string; entry: CurriculumAppEntry }) {
  const c = useColors();
  const next = nextLine(entry);
  return (
    <Card label={`${entry.curriculumName} for ${child}`}>
      <Text style={{ color: c.muted, fontSize: type.caption, fontWeight: '700', letterSpacing: 0.6 }}>{entry.mode === 'RANK' ? 'BY RANK' : 'BY CYCLE'}</Text>
      <Text accessibilityRole="header" style={{ color: c.text, fontSize: type.title, fontWeight: '800', marginTop: space.xs }}>{entry.curriculumName}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm }}>
        {entry.rank?.color ? <View accessibilityElementsHidden importantForAccessibility="no" style={{ width: 16, height: 16, borderRadius: 4, borderWidth: 1, borderColor: c.edge, backgroundColor: entry.rank.color }} /> : null}
        <Text style={{ color: c.text, fontSize: type.body, fontWeight: '700', flexShrink: 1 }}>{nowLine(entry)}</Text>
      </View>
      {next ? <Text style={{ color: c.muted, fontSize: type.body, marginTop: space.xs }}>{next}</Text> : null}
      {!hasMaterial(entry) ? <View style={{ marginTop: space.md }}><Body muted>Your school has not shared videos or documents for this yet.</Body></View> : null}
      {entry.sections.map(section => <MaterialSection key={section.label} title={sectionTitle(entry.mode, section.label)} items={section.items} />)}
    </Card>
  );
}

function MaterialSection({ title, items }: { title: string; items: CurriculumAppItem[] }) {
  const c = useColors();
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, SECTION_PREVIEW);
  return (
    <View style={{ marginTop: space.lg }}>
      <Text accessibilityRole="header" style={{ color: c.text, fontSize: type.body, fontWeight: '800' }}>{title}</Text>
      {shown.map((item, i) => (
        <View key={`i-${i}`} style={{ marginTop: space.md, paddingTop: space.md, borderTopWidth: 1, borderTopColor: c.border }}>
          <Text style={{ color: c.muted, fontSize: type.caption, fontWeight: '700' }}>{KIND_TEXT[item.kind].tag}</Text>
          <Text style={{ color: c.text, fontSize: type.body, fontWeight: '700', marginTop: space.xs }}>{item.title}</Text>
          {item.description ? <View style={{ marginTop: space.xs }}><Body muted>{item.description}</Body></View> : null}
          {/^https:\/\//.test(item.url) ? <View style={{ marginTop: space.sm, alignSelf: 'flex-start' }}>
            <Button kind="quiet" label={KIND_TEXT[item.kind].action} accessibilityLabel={`Open ${item.title}`} onPress={() => { void WebBrowser.openBrowserAsync(item.url); }} />
          </View> : null}
        </View>
      ))}
      {!all && items.length > SECTION_PREVIEW ? <View style={{ marginTop: space.md, alignSelf: 'flex-start' }}>
        <Button kind="quiet" label={`Show all ${items.length}`} accessibilityLabel={`Show all ${items.length} in ${title}`} onPress={() => setAll(true)} />
      </View> : null}
    </View>
  );
}
