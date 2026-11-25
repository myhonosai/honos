// The "No CRM vs. HON OS" section shows estimates. They must say so, show their assumptions,
// and add up: the chart numbers are recomputed here from the assumptions printed on the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const sec = html.match(/<section class="chart-sec" id="cost">[\s\S]*?<\/section>/)[0];
const text = sec.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

function students({ start, leads, join, leave, months }) {
  let s = start;
  for (let m = 0; m < months; m += 1) s = s * (1 - leave) + leads * join;
  return Math.round(s);
}

test('the section is labelled as an estimate, not a promise', () => {
  assert.match(text, /Estimate, not a promise/);
  assert.match(text, /Your results will differ/);
  assert.match(text, /Estimated students 12 months from now/);
  assert.match(text, /Estimated office hours a week/);
  assert.match(text, /With HON OS, we assume/);
  assert.doesNotMatch(text, /guarantee|will grow|proven|on average our schools/i);
});

test('the student numbers follow from the real starting point and the printed assumptions', () => {
  // Real school, last 12 months (owner's monthly report, 2026-11-25): 200 students,
  // 20 trial appointments a month, 64% show, 58% of shows join, about 3.2% leave a month.
  assert.match(text, /real martial arts school in California with 200 students/);
  assert.match(text, /averaged 20 trial appointments a month; 64% showed up, 58% of those joined, and about 3\.2% of students left each month/);
  assert.match(text, /reminders lift show-ups to 75%, follow-ups lift joining to 65%, and absence alerts cut leaving to 2\.5% a month/);
  const today = students({ start: 200, leads: 20 * 0.64, join: 0.58, leave: 0.032, months: 12 });
  const hon = students({ start: 200, leads: 20 * 0.75, join: 0.65, leave: 0.025, months: 12 });
  assert.equal(today, 210);
  assert.equal(hon, 250);
  assert.match(sec, new RegExp(`data-count="${today}" data-pre="">${today}<`));
  assert.match(sec, new RegExp(`data-count="${hon}" data-pre="">${hon}<`));
  assert.match(text, new RegExp(`reaches about ${today} in 12 months`));
  assert.match(text, new RegExp(`giving about ${hon}\\.`));
});

test('the school is not named and no revenue is shown', () => {
  assert.doesNotMatch(text, /Ideal|San Gabriel|\$\d/);
});

test('the weekly hours table adds up to the chart', () => {
  const rows = [...sec.matchAll(/<tr><th scope="row">[^<]+<\/th><td>([\d.]+) h<\/td><td>([\d.]+) h<\/td><\/tr>/g)];
  assert.equal(rows.length, 5);
  const sum = (i) => rows.reduce((t, r) => t + Number(r[i]), 0);
  assert.equal(sum(1), 16);
  assert.equal(sum(2), 5);
  assert.match(sec, /<tr class="total"><th scope="row">Total<\/th><td>16 h<\/td><td>5 h<\/td><\/tr>/);
  assert.match(sec, /data-count="16" data-pre="">16</);
  assert.match(sec, /data-count="5" data-pre="">5</);
});

test('bar heights match their values on each axis', () => {
  assert.match(sec, /--h:70%[^"]*"><b data-count="210"/);
  assert.match(sec, /--h:83\.3%[^"]*"><b data-count="250"/);
  assert.match(sec, /--h:80%[^"]*"><b><span data-count="16"/);
  assert.match(sec, /--h:25%[^"]*"><b><span data-count="5"/);
});
