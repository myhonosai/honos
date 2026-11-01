import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { previewConfiguration, childEnvironment } from './guard.mjs';
const root=resolve(fileURLToPath(new URL('../../../..',import.meta.url)));
previewConfiguration(process.env,root);
const env=childEnvironment(process.env,{audience:'hon-private-synthetic-preview',secret:randomBytes(32).toString('hex')});
for(const args of [['prepare:workspace'],['--filter','@hon/web','build']]) {
 const r=spawnSync('pnpm',args,{cwd:root,env,stdio:'inherit'});if(r.status!==0)throw Error('PREVIEW_BUILD_FAILED');
}
