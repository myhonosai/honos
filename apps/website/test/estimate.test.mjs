// The "Real growth vs. HON OS" section shows a real school's records next to estimates. They must say so,
// and add up: the chart numbers are recomputed here from the assumptions printed on the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const sec = html.match(/<section class="chart-sec" id="cost">[\s\S]*?<\/section>/)[0];
const text = sec.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// The school's own monthly records, September 2022 to October 2026 (owner's sheet, read 2026-11-26).
// Counts only: [joined, left, students at month end, trial appointments, showed up].
const MONTHS = [
  [4, 0, 21, 15, 5],
  [9, 1, 29, 16, 4],
  [8, 1, 36, 30, 12],
  [1, 2, 35, 25, 13],
  [11, 2, 44, 17, 12],
  [10, 2, 52, 20, 13],
  [20, 5, 67, 15, 7],
  [3, 5, 65, 11, 6],
  [8, 0, 73, 18, 7],
  [7, 0, 85, 32, 12],
  [5, 0, 90, 26, 15],
  [13, 3, 100, 37, 14],
  [12, 8, 104, 24, 14],
  [20, 5, 119, 52, 33],
  [9, 8, 120, 49, 14],
  [8, 7, 121, 34, 13],
  [7, 6, 122, 35, 13],
  [15, 2, 135, 35, 17],
  [7, 2, 140, 14, 6],
  [10, 5, 145, 22, 10],
  [1, 14, 132, 19, 7],
  [9, 1, 140, 23, 12],
  [4, 8, 136, 30, 9],
  [2, 2, 136, 15, 7],
  [2, 0, 138, 9, 2],
  [8, 2, 144, 47, 21],
  [2, 9, 137, 21, 5],
  [3, 11, 129, 15, 6],
  [5, 1, 133, 14, 8],
  [12, 1, 144, 43, 28],
  [18, 0, 162, 48, 20],
  [17, 6, 173, 45, 23],
  [14, 6, 181, 30, 19],
  [13, 10, 184, 42, 21],
  [6, 13, 177, 20, 8],
  [6, 1, 183, 29, 16],
  [9, 15, 178, 27, 16],
  [12, 7, 183, 20, 12],
  [4, 4, 183, 7, 5],
  [4, 10, 177, 7, 5],
  [3, 6, 174, 5, 3],
  [8, 4, 178, 31, 19],
  [10, 4, 184, 40, 21],
  [13, 7, 190, 22, 19],
  [9, 9, 190, 16, 11],
  [9, 5, 194, 42, 21],
  [6, 2, 198, 22, 12],
  [9, 5, 202, 15, 13],
  [7, 3, 206, 21, 14],
  [7, 13, 200, 14, 11]
];

/** Replays the real months with HON OS assumptions: more joins from more show-ups, fewer leaving. */
function withHon({ show, leave }) {
  const lift = show / 0.5, cut = leave / 0.037;
  let s = MONTHS[0][2] - MONTHS[0][0] + MONTHS[0][1];
  return MONTHS.map(([joined, left, total]) => {
    const start = total - joined + left;
    s = s - s * (start ? left / start : 0) * cut + joined * lift;
    return Math.round(s);
  });
}

test('the section is labelled as an estimate, not a promise', () => {
  assert.match(text, /Estimate, not a promise/);
  assert.match(text, /Your results will differ/);
  assert.match(text, /Students each October: real vs\. estimated with HON OS/);
  assert.match(text, /Estimated office hours a week/);
  assert.match(text, /For the HON OS estimate we replay the same months/);
  assert.doesNotMatch(text, /guarantee|will grow|proven|on average our schools/i);
});

test('the real numbers are the school records and the estimate follows from the printed assumptions', () => {
  assert.equal(MONTHS.length, 50);
  const sum = (i) => MONTHS.reduce((t, m) => t + m[i], 0);
  const appts = sum(3), showed = sum(4), joined = sum(0);
  assert.equal(appts, 1266);
  assert.equal(Math.round((showed / appts) * 100), 50);
  assert.equal(Math.round((joined / showed) * 100), 66);
  const churn = MONTHS.reduce((t, [j, l, s]) => t + l / (s - j + l), 0) / MONTHS.length;
  assert.equal(Math.round(churn * 1000) / 10, 3.7);
  assert.match(text, /grew from 21 students in September 2022 to 200 in October 2026/);
  assert.equal(MONTHS[0][2], 21);
  assert.equal(MONTHS.at(-1)[2], 200);
  assert.match(text, /1,266 trial appointments, 50% showed up, 66% of those joined, and about 3\.7% of students left each month/);
  assert.match(text, /reminders lift show-ups to 60% and absence alerts cut leaving to 2\.9% a month; joining stays at 66%/);
  const hon = withHon({ show: 0.6, leave: 0.029 });
  // Each October bar: index of that month in MONTHS, real count from the records, estimate from the replay.
  const octobers = [[13, 'Oct 2023'], [25, 'Oct 2024'], [37, 'Oct 2025'], [49, 'Oct 2026']];
  const pairs = [...sec.matchAll(/<div class="pair"><div class="bar" style="--h:([\d.]+)%[^"]*"><b data-count="(\d+)" data-pre="">\2<\/b><\/div><div class="bar hot" style="--h:([\d.]+)%[^"]*"><b data-count="(\d+)" data-pre="">\4<\/b><\/div><\/div>/g)];
  assert.equal(pairs.length, octobers.length);
  octobers.forEach(([i, label], n) => {
    const [, realH, real, honH, est] = pairs[n];
    assert.equal(Number(real), MONTHS[i][2], `${label} real`);
    assert.equal(Number(est), hon[i], `${label} estimate`);
    // Bars are drawn on a 0-300 axis.
    assert.equal(Number(realH), Math.round((MONTHS[i][2] / 300) * 1000) / 10, `${label} real bar height`);
    assert.equal(Number(honH), Math.round((hon[i] / 300) * 1000) / 10, `${label} estimate bar height`);
  });
  assert.ok(sec.includes(octobers.map(([, l]) => `<span>${l}</span>`).join('')));
  assert.match(text, new RegExp(`about ${hon.at(-1)} students by October 2026 instead of 200`));
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

test('hours bar heights match their values', () => {
  assert.match(sec, /--h:80%[^"]*"><b><span data-count="16"/);
  assert.match(sec, /--h:25%[^"]*"><b><span data-count="5"/);
});
