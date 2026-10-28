import {describe,it,expect} from 'vitest';
import {generateKeyPair,SignJWT} from 'jose';
import {oidcConfig} from './config.js';
import {verifyIdToken} from './oidc.js';
import {issueSession,verifySession} from './session.js';
const config=oidcConfig({NODE_ENV:'production',HON_AUTH_MODE:'OIDC',HON_SESSION_JWT_SECRET:'test-only-long-secret-12345678901234567890',HON_SESSION_AUDIENCE:'p0',HON_PUBLIC_ORIGIN:'https://hon.example',HON_OIDC_ISSUER:'https://id.example',HON_OIDC_AUTHORIZATION_ENDPOINT:'https://id.example/auth',HON_OIDC_TOKEN_ENDPOINT:'https://id.example/token',HON_OIDC_JWKS_URI:'https://id.example/keys',HON_OIDC_CLIENT_ID:'hon',HON_OIDC_SCOPES:'openid email',HON_OIDC_REDIRECT_URI:'https://hon.example/auth/callback',HON_OIDC_TOKEN_ENDPOINT_AUTH_METHOD:'none'});
describe('invitation email proof',()=>{
 it.each([true,false,'true',undefined])('only a signed boolean true from OIDC retains proof: %s',async email_verified=>{
  const {privateKey,publicKey}=await generateKeyPair('RS256'),now=Math.floor(Date.now()/1000);
  const token=await new SignJWT({iss:config.issuer,aud:config.clientId,sub:'owner',nonce:'n',iat:now,exp:now+60,email:'owner@example.invalid',email_verified}).setProtectedHeader({alg:'RS256'}).sign(privateKey);
  const identity=await verifyIdToken(token,config,'n',async()=>publicKey);
  expect(identity.emailVerified).toBe(email_verified===true?true:undefined);
  expect(verifySession(issueSession(identity,config),config)).toEqual(identity);
 });
 it('rejects client-shaped nonboolean proof and proof in development sessions',()=>{
  expect(()=>issueSession({externalSubject:'x',email:'a@b.invalid',emailVerified:'true'} as never,config)).toThrow();
  const dev={...config,mode:'MANUS_DEVELOPMENT' as const};
  expect(()=>verifySession(issueSession({externalSubject:'x',email:'a@b.invalid',emailVerified:true},dev),dev)).toThrow();
 });
});
