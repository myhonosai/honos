import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentWorkbench, DocumentAcknowledgementDesk } from '../src/components/document-workbench';
import { NO_SCHOOL_SHELL, SchoolShellProvider, type SchoolShellState } from '../src/components/school-shell/context';
import { loadFamilies, loadPublications, loadTemplate } from '../src/components/documents/document-http';

const school = { organizationId: '11111111-1111-4111-8111-111111111111', schoolId: '22222222-2222-4222-8222-222222222222' };
const ready: SchoolShellState = { ...NO_SCHOOL_SHELL, phase: 'READY', selection: school, schoolName: 'Sunrise' };
const inShell = (node: React.ReactElement) => renderToStaticMarkup(<SchoolShellProvider value={ready}>{node}</SchoolShellProvider>);
const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const publication = { id: id(3), templateId: id(4), versionId: id(5), versionNumber: 2, audience: 'STAFF', title: 'Mat safety rules', content: 'Bow in.', contentHash: 'a'.repeat(64), publishedAt: '2026-11-01T00:00:00.000Z', current: true };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.restoreAllMocks());

describe('staff documents use the signed-in school', () => {
  it('renders plain document controls without requests, raw IDs or legal claims', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const html = inShell(<DocumentWorkbench />);
    expect(fetcher).not.toHaveBeenCalled();
    for (const label of ['Published documents', 'Write a new document', "Who it&#x27;s for", 'Save draft', 'Read document', 'Enter record IDs instead']) expect(html).toContain(label);
    for (const word of ['Organization UUID', 'School UUID', 'Template UUID', 'Verified staff school scope', 'Submit human document command', 'Verifying', 'immutable', 'Sign in', 'authorized'])
      expect(html).not.toContain(word);
    expect(html).not.toContain('<canvas'); expect(html).not.toContain('type="file"'); expect(html).not.toContain('ESIGN'); expect(html).not.toContain('UETA');
  });
  it('outside the shell still offers the school ID boxes as the only way in', () => {
    const html = renderToStaticMarkup(<DocumentWorkbench />);
    expect(html).toContain('Organization UUID'); expect(html).toContain('School UUID'); expect(html).not.toContain('Enter record IDs instead');
  });
  it('the acknowledgement desk picks a current publication by title for staff', () => {
    const html = renderToStaticMarkup(<DocumentAcknowledgementDesk embedded scope={school} publications={[publication as never, { ...publication, id: id(6), title: 'Old rules', current: false } as never]} />);
    expect(html).toContain('Mat safety rules · version 2'); expect(html).not.toContain('Old rules');
    expect(html).not.toContain('School UUID'); expect(html).toContain('Enter record IDs instead'); expect(html).not.toContain('Acknowledge</button>');
  });
});

describe('document reads', () => {
  it('reads the published list, a template and active families for the exact school, with plain errors', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: [publication], meta: {} }))
      .mockResolvedValueOnce(json({ data: { id: id(4), audience: 'STAFF', familyId: null, version: 3, latestVersionId: id(5), versionId: id(5), versionNumber: 2, title: 'Mat safety rules', content: 'Bow in.', contentHash: 'a'.repeat(64), currentPublicationId: id(3) }, meta: {} }))
      .mockResolvedValueOnce(json({ data: [{ id: id(7), displayName: 'Rivera family', status: 'ACTIVE', version: 1, memberCount: 2, createdAt: '2026-10-01T00:00:00.000Z' }, { id: id(8), displayName: 'Archived family', status: 'ARCHIVED', version: 1, memberCount: 0, createdAt: '2026-10-01T00:00:00.000Z' }], meta: {} }))
      .mockResolvedValueOnce(json({ detail: 'PRIVATE internal detail' }, 403));
    expect((await loadPublications(school)).map(p => p.title)).toEqual(['Mat safety rules']);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/v1/organizations/${school.organizationId}/schools/${school.schoolId}/documents/publications`);
    expect((await loadTemplate(school, id(4))).version).toBe(3);
    expect(await loadFamilies(school)).toEqual([{ id: id(7), displayName: 'Rivera family' }]);
    await expect(loadPublications(school)).rejects.toThrow("You don't have permission");
    await expect(loadTemplate(school, 'not-an-id')).rejects.toThrow("couldn't find");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});

describe('parent documents', () => {
  it('parent surface requires a read before an acknowledgement and never accepts family/person/signer input', () => {
    const html = renderToStaticMarkup(<DocumentAcknowledgementDesk parent />);
    expect(html).toContain('Publication UUID'); expect(html).toContain('School UUID'); expect(html).toContain('Only your own receipt');
    expect(html).not.toContain('Organization UUID'); expect(html).not.toContain('family UUID'); expect(html).not.toContain('person UUID'); expect(html).not.toContain('signer UUID');
    expect(html).not.toContain('Acknowledge</button>'); expect(html).not.toContain('<canvas'); expect(html).not.toContain('<img');
  });
});
