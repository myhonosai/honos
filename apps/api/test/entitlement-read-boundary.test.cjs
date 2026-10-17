const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { AiTeamService } = require('../dist/ai-team/ai-team.service.js');
const { AiUsageService } = require('../dist/ai/ai-usage.service.js');
const { LeadService } = require('../dist/crm/lead.service.js');
const { PipelineService } = require('../dist/crm/pipeline.service.js');
const { BillingAccountService } = require('../dist/billing/billing-account.service.js');
const { MembershipService } = require('../dist/billing/membership.service.js');
const { InvoiceService } = require('../dist/billing/invoice.service.js');
const { PersonService } = require('../dist/people/person.service.js');
const { FamilyService } = require('../dist/families/family.service.js');
const { ClassSessionService } = require('../dist/schedule/class-session.service.js');
const { OperationsReportService } = require('../dist/reports/operations-report.service.js');
const { ActionEngineService } = require('../dist/action/action-engine.service.js');

const context = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID(), principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'verified-human', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: randomUUID() };
const leadInput = { pipelineId: randomUUID(), pipelineStageId: randomUUID(), primaryContact: { givenName: 'Existing', familyName: 'Contact' } };
const invoiceInput = { billingAccountId: randomUUID(), membershipId: randomUUID(), dueAt: '2030-05-01T09:15:30Z', currency: 'USD', subtotalMinor: 1250 };
const classSessionInput = { programId: randomUUID(), name: 'Existing Session', startsAt: '2030-05-01T09:15:30Z', endsAt: '2030-05-01T10:15:30Z', capacity: 12, bookingPolicy: 'OPTIONAL_BOOKING' };
const operationsRange = { from: '2030-05-01T00:00:00Z', to: '2030-05-02T00:00:00Z' };
const request = { id: randomUUID(), action_code: 'crm.lead.create', required_permission: 'crm.lead.create', normalized_payload: leadInput, requested_by_principal_id: context.principalId, effective_authority_mode: 'CONFIRM', policy_version: 1, status: 'APPROVED', approval_expires_at: new Date(Date.now() + 60_000) };
const commands = [
  ['lead', LeadService, (service) => service.create(context, leadInput)],
  ['pipeline', PipelineService, (service) => service.create(context, { name: 'Existing', stages: [{ name: 'New' }] })],
  ['billing account', BillingAccountService, (service) => service.create(context, { responsiblePersonId: randomUUID() })],
  ['membership draft', MembershipService, (service) => service.createDraft(context, { billingAccountId: randomUUID(), participantPersonId: randomUUID(), planCode: 'EXISTING' })],
  ['invoice draft', InvoiceService, (service) => service.createDraft(context, invoiceInput)],
  ['invoice issuance', InvoiceService, (service) => service.issue(context, randomUUID(), { expectedVersion: 1 })],
  ['person', PersonService, (service) => service.create(context, { givenName: 'Existing', familyName: 'Person' })],
  ['family', FamilyService, (service) => service.create(context, { displayName: 'Existing Family' })],
  ['family member', FamilyService, (service) => service.addMember(context, randomUUID(), { personId: randomUUID(), memberRole: 'GUARDIAN' })],
  ['class session', ClassSessionService, (service) => service.create(context, classSessionInput)],
  ['operations report', OperationsReportService, (service) => service.read(context, operationsRange)],
  ['action proposal', ActionEngineService, (service) => service.propose(context, { actionCode: 'crm.lead.create', normalizedPayload: leadInput })],
  ['action execution', ActionEngineService, (service) => service.beginExecution(context, request.id)],
  ['AI team list', AiTeamService, (service) => service.list(context), true],
  ['AI team update', AiTeamService, (service) => service.update(context, 'marcus', { expectedVersion: 0, displayName: 'Existing Name' }), true],
];

for (const [name, Service, invoke, completeOnly] of commands) {
  test(`${name} uses the current transaction's no-argument tier boundary and preserves its tier gate`, async () => {
    for (const tier of [null, 'ESSENTIAL', 'CORE', 'COMPLETE']) {
      const reachedDomain = new Error('existing domain work reached');
      let entitlementReads = 0;
      const client = { query: async (sql, args = []) => {
        assert(!/organization_entitlements/i.test(sql), 'No raw entitlement table query is permitted');
        if (sql.includes('hon.read_current_organization_entitlement()')) {
          entitlementReads++;
          assert.deepEqual(args, [], 'The boundary accepts no organization, school, tier, or time selector');
          assert(!sql.includes('$1'));
          const eligible = tier !== null && (!completeOnly || tier === 'COMPLETE');
          return { rows: eligible ? [{ tier }] : [], rowCount: eligible ? 1 : 0 };
        }
        if (sql.includes('principal_has_school_permission')) return { rows: [{ allowed: true }], rowCount: 1 };
        if (sql.includes('FROM hon.action_requests')) return { rows: [request], rowCount: 1 };
        if (sql.includes('set_config') || sql.includes('hon.authorize_campaign_lead')) return { rows: [], rowCount: 0 };
        assert.equal(entitlementReads, 1, 'Existing domain work follows the entitlement gate');
        throw reachedDomain;
      } };
      const database = { withTenantTransaction: async (actualContext, work) => { assert.equal(actualContext, context); return work(client); } };
      const eligible = tier !== null && (!completeOnly || tier === 'COMPLETE');
      await assert.rejects(() => invoke(new Service(database)), eligible
        ? (error) => error === reachedDomain
        : (error) => error.getStatus?.() === 403 && error.getResponse().code === 'TIER_ENTITLEMENT_REQUIRED');
      assert.equal(entitlementReads, 1);
    }
  });
}

test('AI usage retains one aggregate statement and active-tier/null credit semantics through the fixed function', async () => {
  for (const tier of [null, 'ESSENTIAL', 'CORE', 'COMPLETE']) {
    let reads = 0;
    const service = new AiUsageService({ withTenantTransaction: async (actualContext, work) => {
      assert.equal(actualContext, context);
      return work({ query: async (sql, args) => {
        reads++;
        assert(sql.includes('FROM hon.read_current_organization_entitlement()'));
        assert(!/organization_entitlements/i.test(sql));
        assert.deepEqual(args, [context.organizationId, context.schoolId, '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z']);
        return { rows: [{ entitlementTier: tier, customerCredits: '0', providerCostMicrounits: '0', inputUnits: '0', outputUnits: '0', entries: '0', breakdown: [] }], rowCount: 1 };
      } });
    } });
    const summary = await service.read(context, { from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' });
    assert.equal(reads, 1);
    assert.equal(summary.entitlementTier, tier);
    assert.equal(summary.includedCredits, tier === null ? 0 : require('@hon/config').INCLUDED_AI_CREDITS[tier]);
    assert.deepEqual(summary.breakdown, []);
  }
});

test('all API runtime source files stay free of direct organization_entitlements access', () => {
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith('.ts')) assert(!/organization_entitlements/i.test(readFileSync(path, 'utf8')), `Raw entitlement source reference in ${path}`);
    }
  };
  visit(join(__dirname, '../src'));
});
