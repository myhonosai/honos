import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import { Text } from '../ui/text';
import * as WebBrowser from 'expo-web-browser';
import type { ParentProShop } from '@hon/contracts/parent-pro-shop';
import type { ParentRead } from '../api/client';
import { useFamily } from '../family/family-data';
import { Body, Card, Loading, StateMessage } from '../ui/parts';
import { radius, space, type, useColors } from '../ui/theme';

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
      <View style={{ marginTop: space.md }}>
        {shop.products.map(p => {
          const price = shopPrice(p.fromPrice, shop.currency!);
          return (
            <Pressable key={p.productId} accessibilityRole="link" accessibilityLabel={`${p.title}, from ${price}. Open in the school's shop`}
              onPress={() => { if (api.sampleMode) setSampleNote(true); else void WebBrowser.openBrowserAsync(p.url); }}>
              <Card>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                  {p.imageUrl ? <Image source={{ uri: p.imageUrl }} accessibilityIgnoresInvertColors style={{ width: 64, height: 64, borderRadius: radius.md, backgroundColor: c.surface }} />
                    : <View style={{ width: 64, height: 64, borderRadius: radius.md, backgroundColor: c.accentSoft }} />}
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: c.text, fontSize: type.title, fontWeight: '700' }}>{p.title}</Text>
                    <Text style={{ color: c.muted, marginTop: space.xs }}>From {price}</Text>
                  </View>
                  <Text style={{ color: c.accent, fontWeight: '700' }}>Open ›</Text>
                </View>
              </Card>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
