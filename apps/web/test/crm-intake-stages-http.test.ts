import { describe, expect, it, vi } from 'vitest';
import {
  CrmIntakeStagesAccessError,
  crmIntakeStagesPath,
  loadCrmIntakeStages,
  parseCrmIntakeStages,
} from '../src/components/crm-intake-stages-http';

const organizationId = '11111111-1111-4111-8111-111111111111';
const schoolId = '22222222-2222-4222-8222-222222222222';
const pipelineId = '33333333-3333-4333-8333-333333333333';
const stageId = '44444444-4444-4444-8444-444444444444';
const envelope = {
  data: [{ pipelineId, pipelineName: 'Admissions', stageId, stageName: 'New inquiry' }],
  meta: { requestId: organizationId, correlationId: organizationId },
};

function json(status = 200, body: unknown = envelope): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

describe('CRM intake-stage same-origin transport', () => {
  it('issues the exact browser-compatible originless same-origin GET with no authority selectors', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json());
    try {
      await expect(loadCrmIntakeStages(organizationId, schoolId)).resolves.toEqual(envelope.data);
      expect(fetcher).toHaveBeenCalledWith(
        crmIntakeStagesPath(organizationId, schoolId),
        expect.objectContaining({
          method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
          headers: { Accept: 'application/json', 'X-HON-Human-Read': 'crm-intake-stages' },
        }),
      );
      const [, init] = fetcher.mock.calls[0]!;
      expect(Object.keys((init as RequestInit).headers as Record<string, string>).map((key) => key.toLowerCase())).not.toContain('origin');
    } finally { fetcher.mockRestore(); }
  });

  it('accepts only the bounded closed response and clears access on authentication denial', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      expect(() => parseCrmIntakeStages({ ...envelope, data: [{ ...envelope.data[0], secret: 'extra' }] })).toThrow('could not be verified');
      fetcher.mockResolvedValueOnce(json(403, { error: 'forbidden' }));
      await expect(loadCrmIntakeStages(organizationId, schoolId)).rejects.toBeInstanceOf(CrmIntakeStagesAccessError);
      fetcher.mockResolvedValueOnce(json(200, { ...envelope, meta: { ...envelope.meta, correlationId: schoolId } }));
      await expect(loadCrmIntakeStages(organizationId, schoolId)).rejects.toThrow('no verified bounded result');
    } finally { fetcher.mockRestore(); }
  });
});
