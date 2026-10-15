import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DocumentWorkbench, DocumentAcknowledgementDesk } from '../src/components/document-workbench';
describe('internal human document UI',()=>{
  it('renders deliberate append/publish controls without automatic requests or legal claims',()=>{
    const fetcher=vi.spyOn(globalThis,'fetch');
    try{const html=renderToStaticMarkup(<DocumentWorkbench/>);expect(fetcher).not.toHaveBeenCalled();
      for(const label of ['Append new content version','Publish immutable version','Plain-text content','Internal acknowledgement evidence only','Read current publication'])expect(html).toContain(label);
      const publishing=renderToStaticMarkup(<DocumentWorkbench initialMode="publish"/>);expect(publishing).toContain('Expected template version');expect(publishing).toContain('Exact latest content version UUID');expect(publishing).toContain('type="checkbox"');
      expect(html).not.toContain('<canvas');expect(html).not.toContain('type="file"');expect(html).not.toContain('ESIGN');expect(html).not.toContain('UETA');
    }finally{fetcher.mockRestore();}
  });
  it('parent surface requires a read before an acknowledgement and never accepts family/person/signer input',()=>{
    const html=renderToStaticMarkup(<DocumentAcknowledgementDesk parent/>);
    expect(html).toContain('Publication UUID');expect(html).toContain('School UUID');expect(html).toContain('Only your own receipt');
    expect(html).not.toContain('Organization UUID');expect(html).not.toContain('family UUID');expect(html).not.toContain('person UUID');expect(html).not.toContain('signer UUID');
    expect(html).not.toContain('Record internal acknowledgement');expect(html).not.toContain('<canvas');expect(html).not.toContain('<img');
  });
});
