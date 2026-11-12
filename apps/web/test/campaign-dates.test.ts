import { expect, it } from 'vitest';
import { validateCampaignWindow } from '@hon/contracts';
import { campaignEndFromLastDay, campaignStartFromDay, campaignWindowProblem, cohortEndFromLastDay, dayOfInstant, lastDayOfEnd } from '../src/components/campaign-dates';
import { amountToMinor, minorToAmountText } from '../src/components/invoice-pickers';

it('turns a start day and an inclusive last day into the contract UTC window', () => {
  const from = campaignStartFromDay('2026-12-01'), to = campaignEndFromLastDay('2026-12-31');
  expect([from, to]).toEqual(['2026-12-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z']);
  expect(() => validateCampaignWindow(from, to, false)).not.toThrow();
  expect(() => validateCampaignWindow(campaignStartFromDay('2026-12-01'), campaignEndFromLastDay('2026-12-01'), false)).not.toThrow();
  expect(campaignStartFromDay('2026-02-30')).toBe('');
  expect(campaignEndFromLastDay('12/31/2026')).toBe('');
});

it('shows a saved window back as the same days', () => {
  expect(dayOfInstant('2026-12-01T00:00:00.000Z')).toBe('2026-12-01');
  expect(lastDayOfEnd('2027-01-01T00:00:00.000Z')).toBe('2026-12-31');
  expect(lastDayOfEnd('2026-12-15T12:00:00.000Z')).toBe('2026-12-15');
  expect(dayOfInstant('')).toBe('');
});

it('never makes a cohort end in the future', () => {
  const now = Date.parse('2026-11-12T01:30:00.000Z');
  expect(cohortEndFromLastDay('2026-11-10', now)).toBe('2026-11-11T00:00:00.000Z');
  expect(cohortEndFromLastDay('2026-11-12', now)).toBe('2026-11-12T01:30:00.000Z');
  expect(() => validateCampaignWindow(campaignStartFromDay('2026-11-01'), cohortEndFromLastDay('2026-11-12', now), false)).not.toThrow();
});

it('explains a window that cannot be saved in plain words', () => {
  expect(campaignWindowProblem('', '')).toBe('Choose a start day and a last day.');
  expect(campaignWindowProblem(campaignStartFromDay('2026-12-10'), campaignEndFromLastDay('2026-12-01'))).toBe('The last day must be on or after the start day.');
  expect(campaignWindowProblem(campaignStartFromDay('2026-01-01'), campaignEndFromLastDay('2027-06-01'))).toBe('A campaign can run at most 366 days.');
  expect(campaignWindowProblem(campaignStartFromDay('2026-12-01'), campaignEndFromLastDay('2026-12-31'))).toBeNull();
});

it('converts a planned budget typed in the currency to minor units up to the campaign cap and back', () => {
  expect(amountToMinor('1500', 'USD', 1e12)).toBe('150000');
  expect(amountToMinor('9999999999.99', 'USD', 1e12)).toBe('999999999999');
  expect(amountToMinor('10000000000.01', 'USD', 1e12)).toBeNull();
  expect(amountToMinor('500000', 'KRW', 1e12)).toBe('500000');
  expect(minorToAmountText(150000, 'USD')).toBe('1500.00');
  expect(minorToAmountText(5, 'USD')).toBe('0.05');
  expect(minorToAmountText(500000, 'JPY')).toBe('500000');
});

it('the campaign page asks for days and a budget in the currency, not UTC instants or minor units', async () => {
  const React = await import('react'); const { renderToStaticMarkup } = await import('react-dom/server');
  const { CampaignWorkbench } = await import('../src/components/campaign-workbench');
  const html = renderToStaticMarkup(React.createElement(CampaignWorkbench));
  expect(html).toContain('Start day (UTC)<input type="date"');
  expect(html).toContain('Last day (UTC, included)<input type="date"');
  expect(html).toContain('Planned budget (USD, not actual spend)');
  expect(html).not.toMatch(/Start UTC|End UTC|minor units, not actual spend|YYYY-MM-DDTHH/);
});
