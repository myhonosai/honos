import React, { type CSSProperties } from 'react';
import { buildSchoolSitePolicy, findSiteContact, type SchoolSitePolicyKind, type WebsiteDocument } from '@hon/contracts';
import { siteImage } from './site-links';
import { SitePolicyFooter } from './site-policy-footer';
import styles from './school-site.module.css';

/**
 * A2P step 2: the privacy policy or terms page of a published school site, in the site's own look. The words come from
 * buildSchoolSitePolicy (school name + the site's CONTACT block) and render as escaped text; the email and phone become
 * links the same way the CONTACT block renders them.
 */
export function SitePolicyView({ schoolName, document, kind, base }: { schoolName: string; document: WebsiteDocument; kind: SchoolSitePolicyKind; base: string }) {
  const contact = findSiteContact(document), policy = buildSchoolSitePolicy(kind, { schoolName, contact });
  const { palette, font } = document.theme, logo = siteImage(document.theme.logoUrl);
  const theme = { '--site-primary': palette.primary, '--site-accent': palette.accent, '--site-bg': palette.background,
    '--site-surface': palette.surface, '--site-text': palette.text, '--site-font': `var(--site-font-${font.toLowerCase()})` } as CSSProperties;
  const other: SchoolSitePolicyKind = kind === 'privacy' ? 'terms' : 'privacy';
  return <div className={styles.site} style={theme} data-template={document.theme.template} data-mode="public" data-policy={kind}>
    <header className={styles.header}><a className={styles.brand} href={base}>{logo && <img src={logo} alt="" referrerPolicy="no-referrer" />}<span>{schoolName}</span></a></header>
    <main className={styles.main}><article className={styles.block}>
      <h1>{policy.title}</h1>
      <p className={styles.note}>Last updated {policy.updated}</p>
      <p>{policy.intro}</p>
      {policy.sections.map(section => <section key={section.heading}><h2>{section.heading}</h2>{section.paragraphs.map((text, i) => <p key={i}>{text}</p>)}</section>)}
      {(contact.email || contact.phone) && <p>{contact.email && <a href={`mailto:${contact.email}`}>{contact.email}</a>}{contact.email && contact.phone && ' · '}
        {contact.phone && <a href={`tel:${contact.phone.replace(/[^0-9+]/g, '')}`}>{contact.phone}</a>}</p>}
      <p><a href={`${base}/${other}`}>{other === 'privacy' ? 'Privacy policy' : 'Terms of use'}</a> · <a href={base}>Back to {schoolName}</a></p>
    </article></main>
    <SitePolicyFooter schoolName={schoolName} base={base} />
  </div>;
}
