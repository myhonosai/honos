import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({language:'en'}));
vi.mock('../src/components/localization/provider',()=>({useLocale:()=>({preferences:{language:state.language}})}));
import { FamilyAccessWorkspace } from '../src/components/family-access/workbench';
import { familyText } from '../src/components/family-access/copy';
afterEach(()=>vi.restoreAllMocks());
it.each(['en','ko','es'])('%s renders consistent modes, honest limits and no automatic family read',language=>{
 state.language=language;const f=vi.spyOn(globalThis,'fetch');const html=renderToStaticMarkup(<FamilyAccessWorkspace sessionSubject="synthetic-owner"/>);
 for(const key of ['title','mixed','suspension','boundary','modern','classic','big']as const)expect(html).toContain(familyText(language,key));expect(html).not.toContain('Private Family');expect(f).not.toHaveBeenCalled();
});
it.each(['en','ko','es'])('%s acceptance is initially private, status-announced and requires a fresh explicit identity check',language=>{
 state.language=language;const f=vi.spyOn(globalThis,'fetch');const html=renderToStaticMarkup(<FamilyAccessWorkspace sessionSubject="synthetic-parent" acceptance/>);
 expect(html).toContain(familyText(language,'acceptTitle'));expect(html).toContain('role="status"');expect(html).toContain('aria-live="polite"');expect(html).toContain('data-testid="family-access-private"');expect(html).toContain('hidden=""');expect(html).not.toContain('studentProfileId');expect(f).not.toHaveBeenCalled();
});
it('inert school prefills never mount a bound reader, known-reference form or command',()=>{
 state.language='en';const f=vi.spyOn(globalThis,'fetch'),organizationId='00000000-0000-4000-8000-000000000001',schoolId='00000000-0000-4000-8000-000000000002';
 const html=renderToStaticMarkup(<FamilyAccessWorkspace sessionSubject="synthetic-owner" initialOrganizationId={organizationId} initialSchoolId={schoolId}/>);
 expect(html).toContain(`value="${organizationId}"`);expect(html).toContain(`value="${schoolId}"`);expect(html).toContain(familyText('en','knownVerify'));expect(html).not.toContain('data-testid="family-access-private"');expect(f).not.toHaveBeenCalled();
});
