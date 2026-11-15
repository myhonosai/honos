import React, { type CSSProperties, type ReactNode } from 'react';
import type { WebsiteDocument, WebsitePage, WebsiteSection } from '@hon/contracts';
import { siteHref, siteImage, siteParagraphs, siteVideoUrl, type SiteLink } from './site-links';
import { SiteLeadForm } from './site-lead-form';
import styles from './school-site.module.css';

/**
 * WB3: one renderer for a school website, used by the public pages (/sites/<address>) and by the owner's draft preview.
 * Every value comes from a validated document and is rendered as escaped text; links, images and video players go
 * through site-links. No HTML, style or script from a document is ever rendered.
 */
export type SiteMode = 'public' | 'preview';
export interface SiteViewProps { schoolName: string; document: WebsiteDocument; pageSlug: string; base: string; mode: SiteMode }

const FONTS: Record<WebsiteDocument['theme']['font'], string> = {
  MODERN: 'var(--site-font-modern)',
  FRIENDLY: 'var(--site-font-friendly)',
  BOLD: 'var(--site-font-bold)',
  CLASSIC: 'var(--site-font-classic)',
};

/** White or near-black text, whichever reads better on a palette colour (#rrggbb, validated upstream). */
export function readableOn(hex: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return '#ffffff';
  const [r, g, b] = m.slice(1).map((x) => { const c = parseInt(x, 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111111' : '#ffffff';
}

export function findSitePage(document: WebsiteDocument, slug: string): WebsitePage | null {
  return document.pages.find(page => page.slug === slug) ?? null;
}

function Action({ link, label, primary = true }: { link: SiteLink; label: string; primary?: boolean }) {
  if (!link || !label.trim()) return null;
  return <a className={primary ? styles.button : styles.buttonGhost} href={link.href} {...(link.external ? { rel: 'noopener noreferrer', target: '_blank' } : {})}>{label}</a>;
}
function Paras({ text }: { text: unknown }) {
  return <>{siteParagraphs(text).map((lines, i) => <p key={i}>{lines.map((line, j) => <React.Fragment key={j}>{j > 0 && <br />}{line}</React.Fragment>)}</p>)}</>;
}
function Img({ src, alt, className }: { src: unknown; alt: string; className?: string | undefined }) {
  const url = siteImage(src);
  return url ? <img className={className} src={url} alt={alt} loading="lazy" referrerPolicy="no-referrer" decoding="async" /> : null;
}
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const items = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
function Heading({ text }: { text: unknown }) { return str(text).trim() ? <h2>{str(text)}</h2> : null; }
/** Designed artwork for a card with no picture yet: the palette, a belt stripe and the first letter. Decorative only. */
function CardArt({ index, label }: { index: number; label: string }) {
  return <div className={styles.cardArt} data-art={index % 4} aria-hidden="true"><span>{label.trim().charAt(0).toUpperCase()}</span></div>;
}
type Ctx = Readonly<{ schoolName: string; programsId: string | null; programsLabel: string }>;

function Section({ section, base, mode, pageSlug, ctx }: { section: WebsiteSection; base: string; mode: SiteMode; pageSlug: string; ctx: Ctx }): ReactNode {
  const p = section.props;
  // Visitors never see an empty block: a list section with no items (and no text), or contact details with none filled in.
  if (mode === 'public') {
    const listEmpty = items(p.items).length === 0;
    if (['TESTIMONIALS', 'INSTRUCTORS', 'FAQ'].includes(section.type) && listEmpty) return null;
    if (section.type === 'PROGRAMS' && listEmpty && !str(p.intro).trim()) return null;
    if (section.type === 'SCHEDULE' && listEmpty && !str(p.note).trim()) return null;
    if (section.type === 'CONTACT' && !['address', 'phone', 'email', 'hours'].some(k => str(p[k]).trim())) return null;
  }
  switch (section.type) {
    case 'HERO': {
      const image = siteImage(p.imageUrl), split = p.layout === 'SPLIT' && !!image;
      return <section id={section.id} data-section="HERO" className={`${styles.hero} ${split ? styles.heroSplit : image ? styles.heroPhoto : styles.heroArt}`}>
        {image && !split && <><Img src={image} alt="" className={styles.heroBackdrop} /><span className={styles.heroShade} aria-hidden="true" /></>}
        <div className={styles.heroText}>
          {ctx.schoolName && <p className={styles.eyebrow}>{ctx.schoolName}</p>}
          <h1>{str(p.heading)}</h1><Paras text={p.subheading} />
          <div className={styles.actions}><Action link={siteHref(p.ctaHref, base)} label={str(p.ctaLabel)} />
            {ctx.programsId && <a className={styles.buttonGhost} href={`#${ctx.programsId}`}>{ctx.programsLabel}</a>}</div>
        </div>
        {split && <Img src={image} alt="" className={styles.heroImage} />}
      </section>;
    }
    case 'PROGRAMS':
      return <section id={section.id} data-section="PROGRAMS" className={styles.block}><Heading text={p.heading} /><Paras text={p.intro} />
        <ul className={styles.cards}>{items(p.items).map((it, i) => <li key={i} className={styles.card}>
          {siteImage(it.imageUrl) ? <Img src={it.imageUrl} alt="" className={styles.cardImage} /> : <CardArt index={i} label={str(it.name)} />}
          <h3>{str(it.name)}</h3>{str(it.ages) && <p className={styles.meta}>{str(it.ages)}</p>}<Paras text={it.description} /></li>)}</ul></section>;
    case 'SCHEDULE':
      return <section id={section.id} data-section="SCHEDULE" className={styles.block}><Heading text={p.heading} />
        {items(p.items).length > 0 && <table className={styles.table}><thead><tr><th scope="col">Day</th><th scope="col">Time</th><th scope="col">Class</th></tr></thead>
          <tbody>{items(p.items).map((it, i) => <tr key={i}><td>{str(it.day)}</td><td>{str(it.time)}</td><td>{str(it.className)}</td></tr>)}</tbody></table>}
        <Paras text={p.note} /></section>;
    case 'TRIAL_CTA':
      return <section id={section.id} data-section="TRIAL_CTA" className={styles.cta}><Heading text={p.heading} /><Paras text={p.body} /><Action link={siteHref(p.ctaHref, base)} label={str(p.ctaLabel)} /></section>;
    case 'LEAD_FORM':
      if (!str(p.publicFormId)) return mode === 'preview' ? <section id={section.id} data-section="LEAD_FORM" className={styles.block}><Heading text={p.heading} /><p className={styles.note}>Choose a published form to show it here.</p></section> : null;
      return <section id={section.id} data-section="LEAD_FORM" className={styles.block}><Heading text={p.heading} /><Paras text={p.body} />
        <SiteLeadForm publicFormId={str(p.publicFormId)} pageSlug={pageSlug} preview={mode === 'preview'} /></section>;
    case 'BOOKING':
      if (!str(p.bookingPublicId)) return mode === 'preview' ? <section id={section.id} data-section="BOOKING" className={styles.block}><Heading text={p.heading} /><p className={styles.note}>Choose an active booking page to show it here.</p></section> : null;
      return <section id={section.id} data-section="BOOKING" className={styles.cta}><Heading text={p.heading} /><Paras text={p.body} />
        <Action link={{ href: `/book/${str(p.bookingPublicId)}`, external: false }} label={str(p.ctaLabel) || 'Book a time'} /></section>;
    case 'FAQ':
      return <section id={section.id} data-section="FAQ" className={styles.block}><Heading text={p.heading} />
        {items(p.items).map((it, i) => <details key={i} className={styles.faq}><summary>{str(it.question)}</summary><Paras text={it.answer} /></details>)}</section>;
    case 'TESTIMONIALS':
      return <section id={section.id} data-section="TESTIMONIALS" className={styles.block}><Heading text={p.heading} />
        <ul className={styles.cards}>{items(p.items).map((it, i) => <li key={i} className={`${styles.card} ${styles.quote}`}><blockquote><Paras text={it.quote} /></blockquote>{str(it.author) && <p className={styles.meta}>{str(it.author)}</p>}</li>)}</ul></section>;
    case 'INSTRUCTORS':
      return <section id={section.id} data-section="INSTRUCTORS" className={styles.block}><Heading text={p.heading} />
        <ul className={styles.cards}>{items(p.items).map((it, i) => <li key={i} className={styles.card}><Img src={it.imageUrl} alt={str(it.name)} className={styles.cardImage} />
          <h3>{str(it.name)}</h3>{str(it.title) && <p className={styles.meta}>{str(it.title)}</p>}<Paras text={it.bio} /></li>)}</ul></section>;
    case 'TEXT':
      return <section id={section.id} data-section="TEXT" className={styles.block}><Heading text={p.heading} /><Paras text={p.body} /></section>;
    case 'IMAGE': {
      const url = siteImage(p.imageUrl);
      if (!url) return null;
      return <figure id={section.id} data-section="IMAGE" className={styles.figure}><Img src={url} alt={str(p.alt)} />{str(p.caption) && <figcaption>{str(p.caption)}</figcaption>}</figure>;
    }
    case 'VIDEO': {
      const url = siteVideoUrl(p.provider, p.videoId);
      if (!url) return null;
      return <section id={section.id} data-section="VIDEO" className={styles.block}>
        <div className={styles.video}><iframe src={url} title={str(p.title) || 'Video'} loading="lazy" referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-presentation"
          allow="encrypted-media; picture-in-picture; fullscreen" /></div></section>;
    }
    case 'CONTACT':
      return <section id={section.id} data-section="CONTACT" className={styles.block}><Heading text={p.heading} />
        <dl className={styles.contact}>
          {str(p.address) && <><dt>Address</dt><dd><Paras text={p.address} /></dd></>}
          {str(p.phone) && <><dt>Phone</dt><dd><a href={`tel:${str(p.phone).replace(/[^0-9+]/g, '')}`}>{str(p.phone)}</a></dd></>}
          {/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str(p.email)) && <><dt>Email</dt><dd><a href={`mailto:${str(p.email)}`}>{str(p.email)}</a></dd></>}
          {str(p.hours) && <><dt>Hours</dt><dd><Paras text={p.hours} /></dd></>}
        </dl></section>;
    case 'PROMO_BANNER':
      return str(p.text) ? <aside id={section.id} data-section="PROMO_BANNER" className={styles.banner}><span>{str(p.text)}</span><Action link={siteHref(p.ctaHref, base)} label={str(p.ctaLabel)} primary={false} /></aside> : null;
    case 'CHAT':
      // Website chat comes from the Conversation AI web-chat channel; until it is connected nothing is shown to visitors.
      return mode === 'preview' ? <section id={section.id} data-section="CHAT" className={styles.block}><p className={styles.note}>Website chat will appear here once Conversation AI is connected.</p></section> : null;
  }
  return null;
}

export function SiteView({ schoolName, document, pageSlug, base, mode }: SiteViewProps) {
  const page = findSitePage(document, pageSlug);
  if (!page) return null;
  const { palette, font } = document.theme;
  const theme = { '--site-primary': palette.primary, '--site-accent': palette.accent, '--site-bg': palette.background,
    '--site-surface': palette.surface, '--site-text': palette.text, '--site-font': FONTS[font], '--site-on-primary': readableOn(palette.primary) } as CSSProperties;
  const nav = document.pages.filter(p => p.inNav);
  const logo = siteImage(document.theme.logoUrl);
  const programs = page.sections.find(x => x.type === 'PROGRAMS' && (items(x.props.items).length > 0 || mode === 'preview'));
  const ctx: Ctx = { schoolName, programsId: programs?.id ?? null, programsLabel: str(programs?.props.heading).trim() || 'Programs' };
  // The site's main action (the first hero or trial button on this page, else on the home page) sits in the header and,
  // on phones, in a bar that stays at the bottom of the screen.
  const actionOf = (sections: readonly WebsiteSection[]) => {
    for (const x of sections) if ((x.type === 'HERO' || x.type === 'TRIAL_CTA') && str(x.props.ctaLabel).trim()) { const link = siteHref(x.props.ctaHref, base); if (link) return { link, label: str(x.props.ctaLabel) }; }
    return null;
  };
  const main = actionOf(page.sections) ?? actionOf(findSitePage(document, 'home')?.sections ?? []);
  const contact = document.pages.flatMap(p => p.sections).find(x => x.type === 'CONTACT');
  return <div className={styles.site} style={theme} data-template={document.theme.template} data-mode={mode}>
    <header className={styles.header}>
      <a className={styles.brand} href={base}>{logo ? <img src={logo} alt="" referrerPolicy="no-referrer" /> : <span className={styles.monogram} aria-hidden="true">{schoolName.trim().charAt(0).toUpperCase()}</span>}<span>{schoolName}</span></a>
      {nav.length > 1 && <nav aria-label="Site"><ul>{nav.map(p => <li key={p.slug}>
        <a href={p.slug === 'home' ? base : `${base}/${p.slug}`} aria-current={p.slug === page.slug ? 'page' : undefined}>{p.title}</a></li>)}</ul></nav>}
      {main && <span className={styles.headerAction}><Action link={main.link} label={main.label} /></span>}
    </header>
    <main className={styles.main}>{page.sections.map(s => <Section key={s.id} section={s} base={base} mode={mode} pageSlug={page.slug} ctx={ctx} />)}</main>
    <footer className={styles.footer}>
      <div><p className={styles.footerName}>{schoolName}</p>
        {contact && str(contact.props.phone) && <p><a href={`tel:${str(contact.props.phone).replace(/[^0-9+]/g, '')}`}>{str(contact.props.phone)}</a></p>}
        {contact && str(contact.props.address) && <Paras text={contact.props.address} />}</div>
      {nav.length > 1 && <ul className={styles.footerNav}>{nav.map(p => <li key={p.slug}><a href={p.slug === 'home' ? base : `${base}/${p.slug}`}>{p.title}</a></li>)}</ul>}
      <p className={styles.meta}>© {schoolName}</p>
    </footer>
    {main && <div className={styles.stickyAction}><Action link={main.link} label={main.label} /></div>}
  </div>;
}
