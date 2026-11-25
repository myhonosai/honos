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
  assert.match(text, /Estimated students after 12 months/);
  assert.match(text, /Estimated office hours a week/);
  assert.doesNotMatch(text, /guarantee|will grow|proven|on average our schools/i);
});

test('the student numbers follow from the printed assumptions', () => {
  assert.match(text, /100 students at the start/);
  assert.match(text, /10 new leads a month, 3 in 10 join, 3% of students leave each month/);
  assert.match(text, /With HON OS, we assume marketing brings 15 leads a month, follow-up reminders help 4 in 10 join, and absence alerts bring leaving down to 2\.5% a month/);
  const none = students({ start: 100, leads: 10, join: 0.3, leave: 0.03, months: 12 });
  const hon = students({ start: 100, leads: 15, join: 0.4, leave: 0.025, months: 12 });
  assert.equal(none, 100);
  assert.equal(hon, 137);
  assert.match(sec, new RegExp(`data-count="${none}" data-pre="">${none}<`));
  assert.match(sec, new RegExp(`data-count="${hon}" data-pre="">${hon}<`));
  assert.match(text, new RegExp(`about ${hon} after 12 months`));
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
  assert.match(sec, /--h:66\.7%[^"]*"><b data-count="100"/);
  assert.match(sec, /--h:91\.3%[^"]*"><b data-count="137"/);
  assert.match(sec, /--h:80%[^"]*"><b><span data-count="16"/);
  assert.match(sec, /--h:25%[^"]*"><b><span data-count="5"/);
});
