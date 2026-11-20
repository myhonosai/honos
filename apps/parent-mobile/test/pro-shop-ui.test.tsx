import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import { ParentApp } from '../src/ParentApp';
import { createParentApi, type ParentApi } from '../src/api/client';
import { createSampleApi } from '../src/sample/sample-api';
import { verifyParentProShop } from '@hon/contracts/parent-pro-shop';
import { shopPrice } from '../src/more/ProShopArea';
import { NOW } from './fixtures';

jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'dismiss' })) }));

const signedOut = { token: async () => null, clear: async () => {}, subscribe: () => () => {} };
const now = () => new Date(NOW);
let n = 0;
const newKey = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const liveApi = createParentApi({ baseUrl: 'https://api.example.test', getToken: async () => null, fetchImpl: jest.fn() });
const URL = 'https://dojo.myshopify.com/products/sparring-gloves';

async function openShop(api: ParentApi) {
  await render(<ParentApp api={liveApi} session={signedOut} now={now} newKey={newKey} sampleApi={() => api} />);
  await fireEvent.press(await screen.findByRole('button', { name: 'Try with a sample family' }));
  await screen.findByRole('button', { name: 'Open Mia Sample journey' });
  await fireEvent.press(screen.getByRole('tab', { name: 'More' }));
  await fireEvent.press(await screen.findByRole('button', { name: 'Open Pro shop' }));
}
const store = (products: unknown[], available = true) => async () => ({ ok: true as const, data: verifyParentProShop({ schoolName: 'Dojo', available, currency: available ? 'USD' : null, products }) });

beforeEach(() => { (WebBrowser.openBrowserAsync as jest.Mock).mockClear(); });

describe('pro shop', () => {
  it('opens a product on the school store, and nothing else is bought in HON', async () => {
    const api = { ...createSampleApi(now), sampleMode: false, proShop: store([{ productId: '11', title: 'Sparring gloves', imageUrl: null, fromPrice: '19.50', url: URL }]) } as ParentApi;
    await openShop(api);
    expect(await screen.findByText('From $19.50')).toBeTruthy();
    await fireEvent.press(screen.getByRole('link', { name: "Sparring gloves, from $19.50. Open in the school's shop" }));
    expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith(URL);
  });

  it('the sample family never opens a real store', async () => {
    await openShop(createSampleApi(now));
    await fireEvent.press(await screen.findByRole('link', { name: /Sample uniform/ }));
    expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
    expect(screen.getByText(/items do not open a real store/)).toBeTruthy();
  });

  it('says so when the school has no online shop, and shows an error rather than old items', async () => {
    await openShop({ ...createSampleApi(now), proShop: store([], false) } as ParentApi);
    expect(await screen.findByText('Dojo has not opened an online pro shop yet. Ask at the front desk.')).toBeTruthy();
  });

  it('a failed read shows a retry, never products', async () => {
    const proShop = jest.fn(async () => ({ ok: false as const, state: 'unavailable' as const }));
    await openShop({ ...createSampleApi(now), proShop } as ParentApi);
    expect(await screen.findByText('The pro shop is unavailable')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(proShop).toHaveBeenCalledTimes(2);
  });

  it('formats prices in the store currency', () => {
    expect(shopPrice('19.50', 'USD')).toBe('$19.50');
    expect(shopPrice('1200.00', 'CAD')).toBe('CA$1,200.00');
  });
});
