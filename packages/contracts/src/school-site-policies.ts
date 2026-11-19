// A2P step 2: the privacy policy and terms pages HON adds to every published school website. Text messaging carriers
// review these pages before they approve a school's texting registration, so both carry the texting clauses carriers
// look for (no sharing of mobile numbers or consent for marketing, frequency, rates, STOP and HELP). The pages are
// built from facts already on the published site: the school's name and the first CONTACT block, read with the same
// rules the site renderer uses so the policy never shows a different phone or email than the page. Pure functions.
// This is a starting policy for the school to review; it is not legal advice.
import type { WebsiteDocument } from './school-website.js';

export type SchoolSitePolicyKind = 'privacy' | 'terms';
export interface SiteContact { address: string; phone: string; email: string }
export interface SchoolSitePolicySection { heading: string; paragraphs: string[] }
export interface SchoolSitePolicy { kind: SchoolSitePolicyKind; title: string; updated: string; intro: string; sections: SchoolSitePolicySection[] }

/** The date the policy wording last changed. Shown on the pages as "Last updated". */
export const SCHOOL_SITE_POLICY_UPDATED = '2026-11-19';
/** The same test the site renderer uses before it shows an email as a link. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Contact details from the first CONTACT block that has any, home page first. Empty strings when the site has none. */
export function findSiteContact(document: WebsiteDocument): SiteContact {
  for (const page of document.pages) for (const section of page.sections) {
    if (section.type !== 'CONTACT') continue;
    const p = section.props as Record<string, unknown>;
    const contact = { address: str(p.address), phone: str(p.phone), email: EMAIL.test(str(p.email)) ? str(p.email) : '' };
    if (contact.address || contact.phone || contact.email) return contact;
  }
  return { address: '', phone: '', email: '' };
}

/** A carrier-reviewed policy needs a way to reach the school: an email or a phone number. */
export function siteContactReachable(contact: SiteContact): boolean { return !!(contact.email || contact.phone); }

function reach(name: string, c: SiteContact): string {
  const ways = [c.email && `email ${c.email}`, c.phone && `call ${c.phone}`, c.address && `write to ${name}, ${c.address.replace(/\s*\n\s*/g, ', ')}`].filter(Boolean);
  return ways.length ? `To reach ${name}, ${ways.join(', or ')}.` : `Contact ${name} using the contact options on this website.`;
}

const TEXTING_CORE = (name: string) => [
  `If you choose to receive text messages from ${name}, for example by ticking the text message box on one of our forms, we send texts about your enquiry, trial classes, bookings, class times and changes, memberships and, only if you agreed to them separately, offers and events.`,
  'Message frequency varies. Message and data rates may apply.',
  'Reply STOP to any message to stop receiving texts, and reply HELP for help. You can also ask us to stop at any time.',
];

/** Builds the privacy policy or terms page for one school. */
export function buildSchoolSitePolicy(kind: SchoolSitePolicyKind, facts: { schoolName: string; contact: SiteContact }): SchoolSitePolicy {
  const name = facts.schoolName.trim() || 'This school', contact = reach(name, facts.contact);
  if (kind === 'privacy') return {
    kind, title: 'Privacy policy', updated: SCHOOL_SITE_POLICY_UPDATED,
    intro: `${name} runs this website. This policy explains what information we collect, how we use it, and the choices you have.`,
    sections: [
      { heading: 'Information we collect', paragraphs: [
        'Information you give us in our forms and booking pages, such as your name, phone number, email address, the student\'s name and age, and anything you write in a message.',
        'Records of the classes you book or attend, your membership and your messages with us.',
        'Basic technical information your browser sends when you visit, such as the page you opened.'] },
      { heading: 'How we use it', paragraphs: [
        'To answer your enquiry, arrange trial classes and bookings, run memberships and classes, and keep you informed about them.',
        'To send you emails and text messages you agreed to receive. You can stop them at any time.'] },
      { heading: 'Text messages', paragraphs: [
        ...TEXTING_CORE(name),
        'We do not sell or share your mobile phone number or your text message consent with third parties or affiliates for marketing or promotional purposes. Mobile information and text message opt-in data are never shared with anyone except the service providers that deliver our messages for us.'] },
      { heading: 'Who we share information with', paragraphs: [
        'We use service providers to run the school, such as our school management software (HON OS), payment processors and message delivery providers. They use your information only to provide their services to us.',
        'We may also share information when the law requires it. We do not sell your personal information.'] },
      { heading: 'Children', paragraphs: [
        'Parents and guardians give us information about students who are children. We do not knowingly collect personal information directly from children under 13 through this website.'] },
      { heading: 'Your choices', paragraphs: [
        'You can unsubscribe from emails with the link in each email, and stop texts by replying STOP.',
        'You can ask us to see, correct or delete the information we hold about you.'] },
      { heading: 'Contact us', paragraphs: [contact] },
    ],
  };
  return {
    kind, title: 'Terms of use', updated: SCHOOL_SITE_POLICY_UPDATED,
    intro: `These terms apply when you use the ${name} website and its forms and booking pages.`,
    sections: [
      { heading: 'Using this website', paragraphs: [
        'Please give accurate information in our forms. Sending an enquiry or booking a trial class does not create a membership; any membership has its own agreement.',
        'Class times, programs and offers shown here can change. We will confirm details with you directly.'] },
      { heading: 'Text messages', paragraphs: [
        `${name} texts: when you agree to receive text messages from ${name}, you agree to receive the texts described in our privacy policy at the number you gave us.`,
        ...TEXTING_CORE(name),
        'Agreeing to receive text messages is optional and is not a condition of any purchase.',
        'Carriers are not liable for delayed or undelivered messages.',
        'Our privacy policy at /privacy on this website explains how we handle your mobile number.'] },
      { heading: 'Contact us', paragraphs: [contact] },
    ],
  };
}
