import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe,expect,it,vi } from 'vitest';
import { LeadImportWorkbench } from '../src/components/lead-import-workbench';
describe('human Migration Center lead workbench',()=>{
  it('renders deliberate local file/text staging and no actor/tenant selector or false completion',()=>{
    const fetcher=vi.spyOn(globalThis,'fetch');
    try { const html=renderToStaticMarkup(<LeadImportWorkbench/>);expect(fetcher).not.toHaveBeenCalled();
      for(const text of ['Stage first. Review every row.','CSV file (read locally','CSV text','Match each column to a lead field','Don&#x27;t import','6 of 6 columns will be staged','up to 16 matched columns','Stage only','Metadata only','No AI matching','256 KiB','1,000 rows'])expect(html).toContain(text);
      for(const text of ['Organization UUID','School UUID','Actor UUID','Finalized successfully','type="canvas"'])expect(html).not.toContain(text);
      expect(html).toContain('type="file"');expect(html).not.toContain('Finalize this reviewed lead batch');
    } finally { fetcher.mockRestore(); }
  });
  it('uses conventional same-origin APIs, fatal UTF-8, in-memory retry keys and explicit selections',()=>{
    const source=readFileSync(new URL('../src/components/lead-import-workbench.tsx',import.meta.url),'utf8');
    expect(source).toContain("BASE='/api/v1/staff/migration/leads'");expect(source).toContain("new TextDecoder('utf-8',{fatal:true");expect(source).toContain("'X-HON-Human-Command':'lead-import'");expect(source).toContain("'Idempotency-Key':key");
    expect(source).toContain('expectedVersion:batch.version');expect(source).toContain('selectedIndices:selected');expect(source).toContain("b.status!=='FINALIZED'");expect(source).toContain('No success is assumed');expect(source).toContain('allSaved');expect(source).toContain('keepColumns(rows,kept)');expect(source).toContain('leadMappingProblem(visible)');expect(source).not.toContain('JSON.parse(mapping)');
    expect(source).not.toMatch(/localStorage|sessionStorage|dangerouslySetInnerHTML|\/organizations\/|\/schools\//);
    const routes=JSON.parse(readFileSync(new URL('../public/manus-routes.json',import.meta.url),'utf8'));expect(routes.routes.filter((r:{path:string})=>r.path==='/staff/migration/leads')).toHaveLength(1);
  });
});
