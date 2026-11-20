import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../ui/text';
import * as WebBrowser from 'expo-web-browser';
import type { ParentProShop } from '@hon/contracts/parent-pro-shop';
import type { ParentRead } from '../api/client';
import { useFamily } from '../family/family-data';
import { Body, Card, Loading, StateMessage } from '../ui/parts';
import { radius, space, type, useColors, EDGE } from '../ui/theme';
import { Icon } from '../ui/icons';

/** A decimal price string ("19.50") in the store currency; falls back to the plain amount and code. */
export function shopPrice(amount: string, currency: string): string {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(amount)); } catch { return `${amount} ${currency}`; }
}

/**
 * 0581: the school's own Shopify products. Tapping one opens that product on the school's store in the in-app browser;
 * buying happens there, never in HON. Only verified data is shown; a failed read shows an error, never old products.
 */
export function ProShopArea() {
  const { api } = useFamily();
  const c = useColors();
  const [read, setRead] = useState<ParentRead<ParentProShop> | null>(null);
  const [sampleNote, setSampleNote] = useState(false);
  const generation = useRef(0);
  const reload = useCallback(() => {
    const mine = ++generation.current;
    setRead(null);
    void api.proShop().then(r => { if (mine === generation.current) setRead(r); });
  }, [api]);
  useEffect(() => { reload(); return () => { generation.current++; }; }, [reload]);

  if (!read) return <Loading label="Loading the pro shop" />;
  if (!read.ok) return <StateMessage title="The pro shop is unavailable" body="We couldn't load this from your school right now. Nothing old is shown in its place." action={{ label: 'Try again', onPress: reload }} />;
  const shop = read.data;
  if (!shop.available) return <Card style={{ marginTop: space.lg }}><Body muted>{shop.schoolName} has not opened an online pro shop yet. Ask at the front desk.</Body></Card>;
  if (!shop.products.length) return <Card style={{ marginTop: space.lg }}><Body muted>There are no items in the pro shop right now.</Body></Card>;
  return (
    <View style={{ marginTop: space.lg }}>
      <Body muted>Tap an item to open it in {shop.schoolName}'s shop. You buy it there, not in HON.</Body>
      {sampleNote ? <Card><Body>This is the sample family, so items do not open a real store. With your school's account, the item opens in your school's shop.</Body></Card> : null}
      <View style={styles.grid}>
        {shop.products.map((p, i) => {
          const price = shopPrice(p.fromPrice, shop.currency!);
          const tint = [c.accentSoft, c.coralSoft, c.warningSoft, c.successSoft, c.violetSoft, c.cyanSoft][i % 6]!;
          return (
            <Pressable key={p.productId} accessibilityRole="link" accessibilityLabel={`${p.title}, from ${price}. Open in the school's shop`} style={styles.cell}
              onPress={() => { if (api.sampleMode) setSampleNote(true); else void WebBrowser.openBrowserAsync(p.url); }}>
              <Card style={{ padding: space.sm, marginBottom: 0, flex: 1 }}>
                {p.imageUrl ? <Image source={{ uri: p.imageUrl }} accessibilityIgnoresInvertColors style={[styles.picture, { backgroundColor: c.surface }]} />
                  : <View style={[styles.picture, { backgroundColor: tint, alignItems: 'center', justifyContent: 'center' }]}><Icon name="bag" size={44} color={c.subtle} /></View>}
                <Text numberOfLines={2} style={{ color: c.text, fontSize: type.body, fontWeight: '800', marginTop: space.sm }}>{p.title}</Text>
                <Text style={{ color: c.muted, marginTop: 2, fontWeight: '700' }}>From {price}</Text>
                <View style={[styles.open, { backgroundColor: c.accent, borderBottomColor: c.accentEdge }]}><Text style={{ color: c.accentText, fontWeight: '800' }}>Open</Text></View>
              </Card>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { marginTop: space.md, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: space.md },
  cell: { width: '48.5%' },
  picture: { width: '100%', aspectRatio: 1.2, borderRadius: radius.md },
  open: { marginTop: space.sm, minHeight: 40, borderRadius: radius.sm, borderBottomWidth: EDGE, alignItems: 'center', justifyContent: 'center' },
});
