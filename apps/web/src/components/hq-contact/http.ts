import { HQ_CONTACT_COMMANDS, validateHqContactPhoneStartInput, validateHqContactReceipt, validateHqContactTextingInput, validateHqContactView,
  type HqContactPhoneStartInput, type HqContactReceipt, type HqContactTextingInput, type HqContactView } from '@hon/contracts';
import { CommsError, commsCommand, commsRead, type Owned } from '../hq-communications/http';

/**
 * The signed-in person's own number for texts from HON HQ (0282). There is no user id anywhere in these paths: the
 * server takes the person from the session. Reads use the SaaS read guard, commands the SaaS command guard.
 */
const BASE = '/api/v1/me/hq-contact';
export const HQ_CONTACT_REFUSALS: ReadonlySet<string> = new Set(['HQ_TEXTING_UNAVAILABLE', 'HQ_PHONE_ALREADY_CONFIRMED', 'HQ_PHONE_IN_USE',
  'HQ_PHONE_CODE_LIMIT', 'HQ_PHONE_NOT_CONFIRMED', 'HQ_TEXTING_NO_CHANGE', 'HQ_TEXTING_STOPPED_BY_REPLY', 'HQ_PHONE_NONE']);

export const hqContactApi = {
  read(signal: AbortSignal, owned: Owned): Promise<HqContactView> { return commsRead(BASE, signal, owned, validateHqContactView); },
  /** Starts confirming a number. The answer carries the code once; a replay of the same request never does. */
  async startPhone(input: HqContactPhoneStartInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqContactReceipt> {
    let body: HqContactPhoneStartInput;
    try { body = validateHqContactPhoneStartInput(input); } catch { throw new CommsError('INVALID'); }
    const r = await commsCommand(`${BASE}/phone`, HQ_CONTACT_COMMANDS.startPhone, body, key, signal, owned, validateHqContactReceipt, HQ_CONTACT_REFUSALS);
    if (r.operation !== 'PHONE_START' || r.contact.phone !== body.phone) throw new CommsError('UNKNOWN');
    return r;
  },
  async setTexting(input: HqContactTextingInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqContactReceipt> {
    let body: HqContactTextingInput;
    try { body = validateHqContactTextingInput(input); } catch { throw new CommsError('INVALID'); }
    const r = await commsCommand(`${BASE}/texting`, HQ_CONTACT_COMMANDS.setTexting, body, key, signal, owned, validateHqContactReceipt, HQ_CONTACT_REFUSALS);
    if (r.operation !== 'TEXTING' || r.contact.textingOn !== body.enabled) throw new CommsError('UNKNOWN');
    return r;
  },
  async removePhone(expectedVersion: number, key: string, signal: AbortSignal, owned: Owned): Promise<HqContactReceipt> {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new CommsError('INVALID');
    const r = await commsCommand(`${BASE}/phone/remove`, HQ_CONTACT_COMMANDS.removePhone, { expectedVersion }, key, signal, owned, validateHqContactReceipt,
      HQ_CONTACT_REFUSALS);
    if (r.operation !== 'PHONE_REMOVE') throw new CommsError('UNKNOWN');
    return r;
  },
};
export type HqContactApi = typeof hqContactApi;
