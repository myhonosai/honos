import {describe,it,expect} from 'vitest';
import {generateKeyPair,SignJWT} from 'jose';
import jwt from 'jsonwebtoken';
import {oidcConfig,sessionConfig} from './config.js';
import {verifyIdToken} from './oidc.js';
import {issueSession,verifySession,SESSION_SECONDS} from './session.js';
const config=oidcConfig({NODE_ENV:'production',HON_AUTH_MODE:'OIDC',HON_SESSION_JWT_SECRET:'test-only-long-secret-12345678901234567890',HON_SESSION_AUDIENCE:'p0',HON_PUBLIC_ORIGIN:'https://hon.example',HON_OIDC_ISSUER:'https://id.example',HON_OIDC_AUTHORIZATION_ENDPOINT:'https://id.example/auth',HON_OIDC_TOKEN_ENDPOINT:'https://id.example/token',HON_OIDC_JWKS_URI:'https://id.example/keys',HON_OIDC_CLIENT_ID:'hon',HON_OIDC_SCOPES:'openid email',HON_OIDC_REDIRECT_URI:'https://hon.example/auth/callback',HON_OIDC_TOKEN_ENDPOINT_AUTH_METHOD:'none'});
describe('invitation email proof',()=>{
 it.each([true,false,'true',undefined])('only a signed boolean true from OIDC retains proof: %s',async email_verified=>{
  const {privateKey,publicKey}=await generateKeyPair('RS256'),now=Math.floor(Date.now()/1000);
  const token=await new SignJWT({iss:config.issuer,aud:config.clientId,sub:'owner',nonce:'n',iat:now,exp:now+60,email:'owner@example.invalid',email_verified}).setProtectedHeader({alg:'RS256'}).sign(privateKey);
  const identity=await verifyIdToken(token,config,'n',async()=>publicKey);
  expect(identity.emailVerified).toBe(email_verified===true?true:undefined);
  expect(verifySession(issueSession(identity,{...config,emitVerifiedEmail:true}),config)).toEqual(identity);
 });
 it('rejects client-shaped nonboolean proof and proof in development sessions',()=>{
  expect(()=>issueSession({externalSubject:'x',email:'a@b.invalid',emailVerified:'true'} as never,config)).toThrow();
  const dev={...config,mode:'MANUS_DEVELOPMENT' as const};
  expect(()=>verifySession(issueSession({externalSubject:'x',email:'a@b.invalid',emailVerified:true},dev),dev)).toThrow();
 });
});

describe('reader-first verified email rollout',()=>{
 const identity={externalSubject:'oidc:synthetic:owner',email:'owner@example.invalid',emailVerified:true as const};
 const now=100000;
 // The legacy reader's exact closed claim allowlist is the only changed reader rule.
 const legacyRead=(token:string)=>{
  const p=jwt.verify(token,config.secret,{algorithms:['HS256'],issuer:config.mode,audience:config.audience,clockTimestamp:now}) as jwt.JwtPayload;
  if(Object.keys(p).some(k=>!['externalSubject','displayName','email','iss','aud','iat','exp'].includes(k)))throw Error('LEGACY_UNKNOWN_CLAIM');
  return verifySession(token,config,now);
 };
 it('defaults issuance to the old closed shape while retaining verified OIDC evidence internally',()=>{
  const token=issueSession(identity,config,now);
  expect(legacyRead(token)).toEqual({externalSubject:identity.externalSubject,email:identity.email});
  expect(verifySession(token,config,now).emailVerified).toBeUndefined();
 });
 it('upgraded readers accept both shapes, independent of the issuer switch',()=>{
  const token=issueSession(identity,{...config,emitVerifiedEmail:true},now);
  expect(()=>legacyRead(token)).toThrow('LEGACY_UNKNOWN_CLAIM');
  expect(verifySession(token,{...config,emitVerifiedEmail:false},now)).toEqual(identity);
  expect(verifySession(issueSession(identity,config,now),{...config,emitVerifiedEmail:true},now).emailVerified).toBeUndefined();
 });
 it('rollback disables only future issuance; old readers must wait for the full token lifetime',()=>{
  const prior=issueSession(identity,{...config,emitVerifiedEmail:true},now);
  expect(legacyRead(issueSession(identity,{...config,emitVerifiedEmail:false},now))).not.toHaveProperty('emailVerified');
  expect(verifySession(prior,config,now+SESSION_SECONDS-1).emailVerified).toBe(true);
  expect(()=>verifySession(prior,config,now+SESSION_SECONDS)).toThrow();
 });
 it('rejects invalid, unverified-shaped, unknown and forged proof without widening other claims',()=>{
  const body={externalSubject:identity.externalSubject,email:identity.email,iss:config.mode,aud:config.audience,iat:now,exp:now+60};
  for(const patch of [{emailVerified:'true'},{emailVerified:false},{emailVerified:true,email:undefined},{emailVerified:true,roles:['OWNER']}]){
   const token=jwt.sign({...body,...patch},config.secret,{algorithm:'HS256'});
   expect(()=>verifySession(token,config,now)).toThrow();
  }
  expect(()=>verifySession(issueSession(identity,{...config,emitVerifiedEmail:true,secret:'synthetic-wrong-signing-key-123456789'},now),config,now)).toThrow();
 });
 it('accepts only the explicit server-side OIDC issuance setting',()=>{
  const env={HON_AUTH_MODE:'OIDC',HON_SESSION_JWT_SECRET:config.secret,HON_SESSION_AUDIENCE:config.audience};
  expect(sessionConfig(env).emitVerifiedEmail).toBeUndefined();
  expect(sessionConfig({...env,HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'}).emitVerifiedEmail).toBe(true);
  expect(sessionConfig({...env,HON_SESSION_VERIFIED_EMAIL_ENABLED:'false'}).emitVerifiedEmail).toBeUndefined();
  for(const setting of ['','1','TRUE'])expect(()=>sessionConfig({...env,HON_SESSION_VERIFIED_EMAIL_ENABLED:setting})).toThrow();
 });
});
