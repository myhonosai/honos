import { describe,expect,it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const root=join(__dirname,'..');
describe('Claire teaching assistant UI boundary',()=>{
 it('uses a dynamic no-index staff page and a fixed same-origin API base',()=>{const page=readFileSync(join(root,'src/app/staff/teaching-assistant/page.tsx'),'utf8');const http=readFileSync(join(root,'src/components/teaching-assistant-http.ts'),'utf8');expect(page).toContain("dynamic='force-dynamic'");expect(page).toContain('index:false');expect(http).toContain("const base='/api/v1/staff/teaching-assistant'");expect(http).toContain("credentials:'same-origin'");expect(http).toContain("referrerPolicy:'no-referrer'");});
 it('has no curriculum directory or provider/model/tier/authority selector and explains no effects',()=>{const ui=readFileSync(join(root,'src/components/teaching-assistant-workbench.tsx'),'utf8');expect(ui).toContain('does not provide a curriculum directory or list');for(const forbidden of ['Load authorized curriculum','provider<select','model<select','tier<select','authority<select'])expect(ui).not.toContain(forbidden);for(const message of ['No lesson/resource/assessment/student mutation','Unknown provider or persistence outcome is quarantined','different qualified human'])expect(ui).toContain(message);});
 it('registers the requested staff route',()=>{const routes=JSON.parse(readFileSync(join(root,'public/manus-routes.json'),'utf8'));expect(routes.routes).toContainEqual({path:'/staff/teaching-assistant',title:'HON Claire | Curriculum support guide'});});
});
