import { describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { kioskExactInput, KIOSK_SECRET } from '../src/kiosk.js';
const secret=()=>randomBytes(32).toString('base64url');
describe('kiosk opaque input boundary',()=>{
 it('accepts only canonical 32-byte bearer values and exact shapes',()=>{
  const value=secret();
  expect(KIOSK_SECRET.test(value)).toBe(true);
  expect(()=>kioskExactInput({terminalSession:value,claim:secret()},['terminalSession','claim'])).not.toThrow();
  expect(()=>kioskExactInput({terminalSessionId:randomUUID(),terminalSession:value},['terminalSessionId','terminalSession'])).not.toThrow();
 });
 it('rejects caller-selected scope, identity, payment, action and malformed bearer fields',()=>{
  const value=secret();
  for(const input of [{terminalSession:value},{terminalSession:value,claim:secret(),schoolId:randomUUID()},{terminalSession:value,claim:secret(),studentProfileId:randomUUID()},{terminalSession:value,claim:secret(),amount:1},{terminalSession:value,claim:'short'}])expect(()=>kioskExactInput(input,['terminalSession','claim'])).toThrow();
 });
});
