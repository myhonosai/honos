import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { previewConfiguration, childEnvironment } from './guard.mjs';
import { createPreviewServers } from './server.mjs';
const root=resolve(fileURLToPath(new URL('../../../..',import.meta.url))),web=join(root,'apps/web'),req=createRequire(join(web,'package.json'));
let app,servers,closing=false;
async function stop(){if(closing)return;closing=true;for(const s of [servers?.gateway,servers?.api])if(s){s.closeAllConnections();s.close();}app?.kill('SIGTERM');}
try {
 const config=previewConfiguration(process.env,root);
 if(!/^v22\./.test(process.version)||spawnSync(process.execPath,[join(root,'.github/scripts/verify-node-runtime.mjs'),'--expect','22.23.4'],{stdio:'ignore'}).status!==0)throw Error('PREVIEW_PATCHED_NODE_22_23_4_REQUIRED');
 const lock=JSON.parse(await readFile(new URL('./source-lock.json',import.meta.url),'utf8'));
 for(const sha of [lock.main,lock.founder,lock.crm])if(spawnSync('git',['merge-base','--is-ancestor',sha,'HEAD'],{cwd:root,stdio:'ignore'}).status!==0)throw Error('PREVIEW_SOURCE_CHECKPOINT_MISSING');
 for(const [path,digest] of Object.entries(lock.files))if(createHash('sha256').update(await readFile(join(root,path))).digest('hex')!==digest)throw Error('PREVIEW_SOURCE_CHECKPOINT_CHANGED');
 await readFile(join(web,'.next/BUILD_ID'),'utf8');
 const manifest=JSON.parse(await readFile(join(web,'.next/routes-manifest.json'),'utf8'));
 const rewrites=Array.isArray(manifest.rewrites)?manifest.rewrites:Object.values(manifest.rewrites).flat();
 if(rewrites.length!==1||rewrites[0].destination!=='http://127.0.0.1:3001/v1/:path*')throw Error('PREVIEW_REBUILD_WITH_LOOPBACK_API_REQUIRED');
 const accessCode=randomBytes(24).toString('base64url'),session={mode:'OIDC',audience:'hon-private-synthetic-preview',secret:randomBytes(32).toString('hex')};
 servers=createPreviewServers({...config,session,accessCode,guideText:await readFile(join(root,'docs/OWNER_INTERACTIVE_PREVIEW.md'),'utf8')});
 await new Promise((done,reject)=>{servers.api.once('error',reject);servers.api.listen(3001,'127.0.0.1',done);});
 app=spawn(process.execPath,[req.resolve('next/dist/bin/next'),'start','--hostname','127.0.0.1','--port','3100'],{cwd:web,env:childEnvironment(process.env,session),stdio:'ignore'});
 app.once('error',()=>{void stop();process.exitCode=1;});app.once('exit',()=>{if(!closing){console.error('PREVIEW_APPLICATION_STOPPED');process.exitCode=1;void stop();}});
 let ready=false;for(let i=0;i<100;i++){if(closing)break;try{const r=await fetch('http://127.0.0.1:3100/api/identity/me',{redirect:'manual'});if(r.status===401){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,200));}
 if(!ready)throw Error('PREVIEW_APPLICATION_START_FAILED');
 await new Promise((done,reject)=>{servers.gateway.once('error',reject);servers.gateway.listen(3000,'127.0.0.1',done);});
 console.log(`HON OS SYNTHETIC PREVIEW — no database, provider, payments or AI execution.\nOpen port 3000 only; keep GitHub visibility Private.\nTemporary preview access code (keep in your terminal): ${accessCode}\n${config.secure?'Use the actual HTTPS address in the Codespaces Ports tab.':'Local review: http://127.0.0.1:3000/__preview'}\nCtrl+C stops servers; separately stop/delete the Codespace to stop compute/storage usage.`);
 process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
}catch(e){console.error(/^[A-Z0-9_]+$/.test(e.message)?e.message:'PREVIEW_START_REFUSED');process.exitCode=1;await stop();}
