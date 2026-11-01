import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewConfiguration, childEnvironment } from './guard.mjs';
const run = fn => {const dir=mkdtempSync(join(tmpdir(),'hon-preview-guard-'));mkdirSync(join(dir,'apps/web'),{recursive:true});try{fn(dir);}finally{rmSync(dir,{recursive:true,force:true});}};
test('default and production processes cannot start the synthetic gateway',()=>run(root=>{
 for(const env of [{},{HON_DEPLOYMENT_ENVIRONMENT:'production',HON_PRIVATE_PREVIEW_LOCAL:'1'},{HON_DEPLOYMENT_ENVIRONMENT:'staging',HON_PRIVATE_PREVIEW_LOCAL:'1'}])assert.throws(()=>previewConfiguration(env,root));
}));
test('local opt-in binds only the fixed loopback origin',()=>run(root=>assert.deepEqual(previewConfiguration({HON_PRIVATE_PREVIEW_LOCAL:'1'},root),{origin:'http://127.0.0.1:3000',secure:false})));
test('Codespaces needs explicit private-port acknowledgement, canonical domain and validated name',()=>run(root=>{
 const good={CODESPACES:'true',CODESPACE_NAME:'hon-synthetic-abc',GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:'app.github.dev',HON_PRIVATE_PORT_CONFIRMED:'1'};
 assert.equal(previewConfiguration(good,root).secure,true);
 for(const patch of [{HON_PRIVATE_PORT_CONFIRMED:'0'},{CODESPACE_NAME:'host/evil'},{GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:'example.test'},{HON_PRIVATE_PREVIEW_LOCAL:'1'}])assert.throws(()=>previewConfiguration({...good,...patch},root));
}));
test('real database/provider credentials and non-loopback API overrides are refused without leaking values',()=>run(root=>{
 for(const key of ['DATABASE_URL','HON_RUNTIME_DATABASE_URL','HON_SESSION_JWT_SECRET','STRIPE_SECRET_KEY','OPENAI_API_KEY','ZERNIO_API_KEY','TWILIO_AUTH_TOKEN','SUPABASE_SERVICE_ROLE_KEY']) {
  assert.throws(()=>previewConfiguration({HON_PRIVATE_PREVIEW_LOCAL:'1',[key]:'PRIVATE_CANARY'},root),e=>e.message==='PREVIEW_CREDENTIALS_REFUSED'&&!e.message.includes('PRIVATE_CANARY'));
 }
 assert.throws(()=>previewConfiguration({HON_PRIVATE_PREVIEW_LOCAL:'1',HON_API_BASE_URL:'https://example.test'},root));
}));
test('Next dotenv auto-loading cannot introduce ambient credentials',()=>run(root=>{
 writeFileSync(join(root,'.env.example'),'');previewConfiguration({HON_PRIVATE_PREVIEW_LOCAL:'1'},root);
 writeFileSync(join(root,'apps/web/.env.local'),'PRIVATE_CANARY');assert.throws(()=>previewConfiguration({HON_PRIVATE_PREVIEW_LOCAL:'1'},root),/PREVIEW_DOTENV_REFUSED/);
}));
test('the Next subprocess receives an explicit minimal environment, never inherited provider or GitHub tokens',()=>{
 const env=childEnvironment({PATH:'/bin',HOME:'/tmp',GITHUB_TOKEN:'PRIVATE',OPENAI_API_KEY:'PRIVATE',HON_API_BASE_URL:'https://example.test'},{audience:'synthetic',secret:'synthetic-only'});
 assert.equal(env.HON_API_BASE_URL,'http://127.0.0.1:3001');assert.equal(env.HON_DEPLOYMENT_ENVIRONMENT,'preview');assert.equal(env.HON_AUTH_MODE,'OIDC');assert(!JSON.stringify(env).includes('PRIVATE'));assert.equal(env.GITHUB_TOKEN,undefined);
});
