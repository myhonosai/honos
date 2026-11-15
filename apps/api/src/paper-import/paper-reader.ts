import { paperImportColumns, type PaperImportKind, type PaperImportReadOutcome } from '@hon/contracts';

export const PAPER_READER_RUNTIME = Symbol('PAPER_READER_RUNTIME');

export interface PaperReadingInput { kind: PaperImportKind; checksums: readonly string[] }
export interface PaperReadingResult { reader: 'SYNTHETIC'; outcome: PaperImportReadOutcome; rows: string[][]; unsure: boolean[][] }

/**
 * Server-only reading boundary for paper import (0388). The only implementation is the stand-in: no page, checksum or
 * name ever leaves the server, and nothing is charged. A real vision provider needs owner approval and a new migration
 * (the database accepts SYNTHETIC as the only reader).
 */
export interface PaperReaderRuntime { read(input: PaperReadingInput): Promise<PaperReadingResult> }

type Sample = { kind: PaperImportKind; rows: Record<string, string>[]; unsure: string[][] };

/**
 * The three built-in sample pages (apps/web/public/paper-import-samples, synthetic people only), keyed by the SHA-256 of
 * the stored bytes. They let staff try the whole flow end to end before real reading is switched on.
 */
export const PAPER_IMPORT_SAMPLES: Readonly<Record<string, Sample>> = {
  '4fccc55efbc5082b5dda7313373e921b20cab3c8fa7b55bb91d0e98bf0d05184': {
    kind: 'ATTENDANCE_SHEETS',
    rows: [
      { studentGivenName: 'Mina', studentFamilyName: 'Park', attendedOn: '2026-11-02', visits: '1', className: 'Kids Taekwondo' },
      { studentGivenName: 'Leo', studentFamilyName: 'Santos', attendedOn: '2026-11-02', visits: '1', className: 'Kids Taekwondo' },
      { studentGivenName: 'Ava', studentFamilyName: 'Reyes', attendedOn: '2026-11-04', visits: '2', className: 'Kids Taekwondo' },
      { studentGivenName: 'Noah', studentFamilyName: 'Kim', attendedOn: '2026-11-04', visits: '1', className: 'Kids Taekwondo' },
    ],
    unsure: [[], [], ['visits'], []],
  },
  'a71c25bfb84061f5e6e81f78ace99bf6683cf7d59cbcb5c9d0cc83702c9d345b': {
    kind: 'STUDENT_CARDS',
    rows: [{ studentGivenName: 'Mina', studentFamilyName: 'Park', birthDate: '2017-03-14', guardianGivenName: 'Grace', guardianFamilyName: 'Park',
      guardianEmail: 'grace.park@example.com', guardianMobile: '+12135550142', familyKey: 'park' }],
    unsure: [['guardianMobile']],
  },
  '545afa8f818e91fba38b0b50d33c40756d1817a16a53b539cccc27487ce014cd': {
    kind: 'CONTRACTS',
    rows: [{ studentGivenName: 'Leo', studentFamilyName: 'Santos', birthDate: '2015-08-30', guardianGivenName: 'Daniel', guardianFamilyName: 'Santos',
      guardianEmail: 'd.santos@example.com', guardianMobile: '+13235550198', familyKey: 'santos' }],
    unsure: [['guardianEmail']],
  },
};

/**
 * The stand-in reader. Pages that are built-in samples of the chosen kind are "read" from their known content, in page
 * order; if no page is a sample, the result is an empty table (NOT_READABLE) for staff to fill in beside the photo. It never
 * guesses at a real photo.
 */
export class SyntheticPaperReader implements PaperReaderRuntime {
  async read(input: PaperReadingInput): Promise<PaperReadingResult> {
    const columns = paperImportColumns(input.kind);
    const rows: string[][] = [], unsure: boolean[][] = [];
    for (const checksum of input.checksums) {
      const sample = PAPER_IMPORT_SAMPLES[checksum];
      if (!sample || sample.kind !== input.kind) continue;
      sample.rows.forEach((row, i) => {
        rows.push(columns.map((c) => row[c] ?? ''));
        unsure.push(columns.map((c) => sample.unsure[i]?.includes(c) ?? false));
      });
    }
    return { reader: 'SYNTHETIC', outcome: rows.length ? 'SAMPLE_READ' : 'NOT_READABLE', rows, unsure };
  }
}
