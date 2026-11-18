import React from 'react';
import { LOCATION_COUNTRIES, countryName, locationCopy } from './copy';
import { regionsFor, type LocationDraft, type LocationField } from './draft';

/** 0392: the school address inputs, shared by sign-up and Settings > School location. */
export function AddressFields({ draft, language, disabled, onEdit, fieldClassName }: {
  draft: LocationDraft; language: string; disabled?: boolean | undefined; onEdit: (field: LocationField, value: string) => void; fieldClassName?: string | undefined;
}): React.ReactElement {
  const c = locationCopy(language), regions = regionsFor(draft.country);
  const regionLabel = draft.country === 'CA' ? c.regionNames.CA : c.regionNames.US;
  const countries = [...LOCATION_COUNTRIES].sort((a, b) => countryName(a, language).localeCompare(countryName(b, language), language));
  const text = (name: LocationField, label: string, max: number, optional: boolean, autoComplete: string) =>
    <label className={fieldClassName}>{label}{optional ? ` ${c.optional}` : ''}
      <input type="text" value={draft[name]} maxLength={max} disabled={disabled} autoComplete={autoComplete} data-location-field={name}
        onChange={e => onEdit(name, e.currentTarget.value)} /></label>;
  return <fieldset data-location-fields disabled={disabled}>
    <legend>{c.addressTitle}</legend>
    <p>{c.addressHelp}</p>
    <label className={fieldClassName}>{c.country}
      <select value={draft.country} aria-label={c.country} data-location-field="country" autoComplete="country"
        onChange={e => onEdit('country', e.currentTarget.value)}>
        <option value="">{c.chooseCountry}</option>
        {countries.map(code => <option key={code} value={code}>{countryName(code, language)}</option>)}
      </select></label>
    {regions.length ? <label className={fieldClassName}>{regionLabel}
      <select value={draft.region} aria-label={regionLabel} data-location-field="region" autoComplete="address-level1" onChange={e => onEdit('region', e.currentTarget.value)}>
        <option value="">{c.chooseRegion}</option>
        {regions.map(r => <option key={r} value={r}>{r}</option>)}
      </select></label> : null}
    {text('city', c.city, 100, false, 'address-level2')}
    {text('postalCode', c.postalCode, 20, true, 'postal-code')}
    {text('addressLine1', c.addressLine1, 200, true, 'address-line1')}
    {text('addressLine2', c.addressLine2, 200, true, 'address-line2')}
  </fieldset>;
}
