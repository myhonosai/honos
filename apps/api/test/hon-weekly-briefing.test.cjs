const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const contracts = require('@hon/contracts');

// 0257 weekly briefing, part 1: owner switch and hour, "email me" for oneself, and a preview. Nothing is sent here.

test('0257 settings input is closed: enabled boolean and a send hour 6-11', () => {
  assert.deepEqual(contracts.validateSchoolBriefingSettingsInput({ enabled: true, sendHour: 8 }), { enabled: true, sendHour: 8 });
  for (const bad of [{}, { enabled: 'yes', sendHour: 8 }, { enabled: true, sendHour: 5 }, { enabled: true, sendHour: 12 }, { enabled: true, sendHour: 8.5 }, { enabled: true, sendHour: 8, extra: 1 }, null]) {
    assert.throws(() => contracts.validateSchoolBriefingSettingsInput(bad), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(contracts.validateMySchoolBriefingInput({ email: false }), { email: false });
  for (const bad of [{}, { email: 1 }, { email: true, sms: true }, { sms: true }]) assert.throws(() => contracts.validateMySchoolBriefingInput(bad), undefined, JSON.stringify(bad));
});

test('0257 read, receipt and preview shapes are exact', () => {
  const view = { enabled: false, sendHour: 8, canManage: true, me: { email: false, canSubscribe: true } };
  assert.deepEqual(contracts.validateSchoolBriefing(view), view);
  for (const bad of [{ ...view, extra: 1 }, { ...view, sendHour: 13 }, { ...view, me: { email: false } }, { ...view, me: { ...view.me, sms: true } }]) assert.throws(() => contracts.validateSchoolBriefing(bad), undefined, JSON.stringify(bad));
  assert.deepEqual(contracts.validateSchoolBriefingReceipt({ record: view, replayed: false }).replayed, false);
  const preview = { subject: 'HON weekly briefing: Demo Dojo', text: 'Line one.\nLine two.' };
  assert.deepEqual(contracts.validateSchoolBriefingPreview(preview), preview);
  for (const bad of [{ ...preview, html: '<b>' }, { ...preview, subject: '' }, { ...preview, text: 'x'.repeat(4001) }]) assert.throws(() => contracts.validateSchoolBriefingPreview(bad));
});

test('0257 API: four briefing routes under the HON human-UI guard; writes need a key and validate first', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/hon-conversation/hon-conversation.controller.ts'), 'utf8');
  for (const route of [/@Get\('briefing'\)/, /@Get\('briefing\/preview'\)/, /@Post\('briefing\/settings'\)/, /@Post\('briefing\/me'\)/]) assert.match(src, route);
  assert.match(src, /hon\.read_school_briefing\(\$1\)/);
  assert.match(src, /hon\.read_school_briefing_preview\(\$1\)/);
  assert.match(src, /hon\.set_school_briefing_settings\(\$1,\$2::jsonb,\$3,current_setting\('app\.hon_request_id'\)::uuid,/);
  assert.match(src, /hon\.set_my_school_briefing\(\$1,\$2::jsonb,\$3,current_setting\('app\.hon_request_id'\)::uuid,/);
  assert.match(src, /validateSchoolBriefingSettingsInput\(input\)/);
  assert.match(src, /validateMySchoolBriefingInput\(input\)/);
});
