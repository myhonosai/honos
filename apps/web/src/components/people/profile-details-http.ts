import { accountClosed, accountUuid, validatePersonDetails, validatePersonDetailsUpdateInput, validatePersonDetailsUpdateResult,
  type PersonDetails, type PersonDetailsUpdateInput, type PersonDetailsUpdateResult } from '@hon/contracts';
import { PersonRecordError, codeOf, exchange, personErrorFor } from './http';

/**
 * 0656 profile details of one person at the selected school: gender, parent/guardian name, notes, labels for the primary
 * phone and email, and up to five other phones and emails. The server decides authority from the verified session (people
 * read, plus people update to save); the browser names the school and person and sends one closed body with the person-record
 * human-command marker and an idempotency key. Nothing is sent to the other addresses.
 */
export type Owned = () => boolean;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Only an unknown outcome or a busy record keeps the exact request for Try again. */
export const keepDetailsForRetry = (error: unknown) => !(error instanceof PersonRecordError) || error.kind === 'UNKNOWN' || error.kind === 'BUSY';

export const detailsApi = {
  async read(schoolId: string, personId: string, signal: AbortSignal): Promise<PersonDetails> {
    let path: string;
    try { path = `/api/v1/school/schools/${accountUuid(schoolId).toLowerCase()}/people/${accountUuid(personId).toLowerCase()}/details`; } catch { throw new PersonRecordError('INVALID'); }
    const { status, value } = await exchange(path, signal);
    if (status !== 200) throw personErrorFor(status, codeOf(value));
    try { return validatePersonDetails(accountClosed(value, ['data']).data, personId); } catch { throw new PersonRecordError('UNKNOWN'); }
  },
  /** One save attempt. The same key and body replay the saved answer; nothing is ever applied twice. */
  async update(input: PersonDetailsUpdateInput, primary: Readonly<{ email: string | null; phoneE164: string | null }>, key: string, signal: AbortSignal, owned: Owned)
    : Promise<PersonDetailsUpdateResult> {
    let body: PersonDetailsUpdateInput, k: string;
    try { body = validatePersonDetailsUpdateInput(input, primary); k = accountUuid(key); } catch { throw new PersonRecordError('INVALID'); }
    const path = '/api/v1/school/people/details';
    let r: { status: number; value: unknown };
    try { r = await exchange(path, signal, { path, body: JSON.stringify(body), key: k, owned }); }
    catch (error) { if (error instanceof PersonRecordError) throw error; throw new PersonRecordError('UNKNOWN'); }
    if (r.status !== 200) throw personErrorFor(r.status, codeOf(r.value));
    try {
      const result = validatePersonDetailsUpdateResult(accountClosed(r.value, ['data']).data, body.personId), d = result.details;
      if (!same(d.personId, body.personId) || d.version <= body.expectedVersion || d.gender !== body.gender || d.guardianName !== body.guardianName
        || d.notes !== body.notes || d.primaryPhoneLabel !== body.primaryPhoneLabel || d.primaryEmailLabel !== body.primaryEmailLabel
        || JSON.stringify(d.otherPhones) !== JSON.stringify(body.otherPhones) || JSON.stringify(d.otherEmails) !== JSON.stringify(body.otherEmails)) throw new Error('mismatch');
      return result;
    } catch { throw new PersonRecordError('UNKNOWN'); }
  },
};
export type DetailsApi = typeof detailsApi;
