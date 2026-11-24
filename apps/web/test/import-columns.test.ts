import { describe, expect, it } from 'vitest';
import { guessLeadMapping, keepColumns, leadMappingProblem, parseCsv } from '../src/components/import-columns';
import { guessMapping, mappingProblem } from '../src/components/student-import/http';

describe('import column helpers', () => {
  it('parses strict CSV with quotes, escaped quotes, CRLF, BOM and a trailing newline', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n1,\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['1', '']]);
    expect(parseCsv('a,b\n"multi\nline",2')).toEqual([['a', 'b'], ['multi\nline', '2']]);
  });
  it('rejects broken quoting, stray carriage returns and ragged rows', () => {
    for (const bad of ['a,b\n"open,1', 'a,b\nx"y",1\n', 'a,b\n"x"y,1', 'a,b\r1,2', 'a,b\n1,2,3', '']) expect(parseCsv(bad)).toBeNull();
  });
  it('keeps only the chosen columns in order and leaves cell text unchanged', () => {
    const rows = parseCsv('Id,First Name,Notes,Last Name\n7,Ana,"has, comma",Kim\n8, Bo ,"a ""q""",Lee\n')!;
    const out = keepColumns(rows, ['Last Name', 'First Name']);
    expect(out).toBe('First Name,Last Name\nAna,Kim\n" Bo ",Lee\n');
    expect(parseCsv(out)).toEqual([['First Name', 'Last Name'], ['Ana', 'Kim'], [' Bo ', 'Lee']]);
    expect(parseCsv(keepColumns(rows, ['Notes']))).toEqual([['Notes'], ['has, comma'], ['a "q"']]);
  });
  it('recognises common lead export column names and leaves the rest unmatched', () => {
    const m = guessLeadMapping(['Contact ID', 'First Name', 'Last Name', 'Full Name', 'Email Address', 'Cell Phone', 'Lead Source', 'Notes', 'Date Created', 'Phone']);
    expect(m).toEqual({ 'Contact ID': null, 'First Name': 'givenName', 'Last Name': 'familyName', 'Full Name': null, 'Email Address': 'email', 'Cell Phone': 'mobile', 'Lead Source': 'source', Notes: 'note', 'Date Created': null, Phone: null });
    expect(guessLeadMapping(['Name', 'E-mail'])).toEqual({ Name: 'displayName', 'E-mail': 'email' });
  });
  it('checks a lead mapping by the server rules before staging', () => {
    expect(leadMappingProblem({ a: 'givenName', b: 'familyName', c: null })).toBeNull();
    expect(leadMappingProblem({ a: 'displayName' })).toBeNull();
    expect(leadMappingProblem({ a: 'givenName' })).toBe('HALF_NAME');
    expect(leadMappingProblem({ a: 'email' })).toBe('NAMES');
    expect(leadMappingProblem({ a: 'email', b: 'email', c: 'displayName' })).toBe('DUPLICATE');
    expect(leadMappingProblem({ a: null })).toBe('NOTHING');
  });
  it('recognises common student and family export column names', () => {
    const m = guessMapping(['Member First Name', 'Member Last Name', 'Birthdate', 'Parent 1 First Name', 'Parent 1 Last Name', 'Parent 1 Email', 'Parent 1 Cell Phone', 'Household ID', 'Belt Rank']);
    expect(m).toEqual({ 'Member First Name': 'studentGivenName', 'Member Last Name': 'studentFamilyName', Birthdate: 'birthDate', 'Parent 1 First Name': 'guardianGivenName', 'Parent 1 Last Name': 'guardianFamilyName', 'Parent 1 Email': 'guardianEmail', 'Parent 1 Cell Phone': 'guardianMobile', 'Household ID': 'familyKey', 'Belt Rank': 'ignore' });
  });
  it('lets a wide student export through when at most 24 columns are matched', () => {
    const wide: Record<string, 'ignore' | 'studentGivenName' | 'studentFamilyName'> = { First: 'studentGivenName', Last: 'studentFamilyName' };
    for (let i = 0; i < 40; i++) wide[`Extra ${i}`] = 'ignore';
    expect(mappingProblem(wide)).toBeNull();
    const tooMany = { ...wide } as Record<string, string>;
    for (let i = 0; i < 23; i++) tooMany[`Extra ${i}`] = 'studentEmail';
    expect(mappingProblem(tooMany as never)).toBe('TOO_MANY_COLUMNS');
  });
});
