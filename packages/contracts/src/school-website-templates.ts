// WB4: the starting templates (five from proven school sites, three modern product looks in 0660) and the closed edit operations for a school website document. A template is a
// deterministic fill of school facts HON already holds (name, contact details); it is not AI. The same edit operations
// are what the owner's editor applies today and what AI edit proposals (WB5) will be limited to.
import {
  WEBSITE_MAX_ITEMS, WEBSITE_MAX_PAGES, WEBSITE_MAX_SECTIONS, WEBSITE_SECTION_SPECS, WEBSITE_SECTION_ID, WEBSITE_PAGE_SLUG, validateWebsiteDocument, websiteStarterArtUrl, websiteBuiltInPageSlug,
  type WebsiteDocument, type WebsitePage, type WebsitePageKind, type WebsiteSection, type WebsiteSectionType, type WebsiteTemplate, type WebsiteTheme, type WebsiteStarterArt,
} from './school-website.js';

/** 0660: each template starts with its own starter hero and the shared program art (see WEBSITE_STARTER_ART). */
const HERO_ART = { MODERN_CLEAN: 'hero-modern', FAMILY_FRIENDLY: 'hero-family', BOLD_POWERFUL: 'hero-bold', TRADITIONAL: 'hero-traditional', HIGH_CONVERSION: 'hero-conversion', NEON_GRID: 'hero-neon', EDITORIAL: 'hero-editorial', BENTO: 'hero-bento' } as const satisfies Record<WebsiteTemplate, WebsiteStarterArt>;

/** A weekly class as HON's timetable holds it: ISO weekdays (1 = Monday) and a school-time start "HH:MM". */
export interface WebsiteSchoolClass { name: string; weekdays: readonly number[]; localStartTime: string }
/**
 * What HON already knows about the school. Everything past the name is optional: a one-tap site fills programs, the
 * weekly schedule, the enquiry form and the booking page from it; anything missing keeps the template's sample.
 */
export interface WebsiteSchoolFacts {
  schoolName: string; phone?: string; email?: string; address?: string;
  programs?: readonly string[]; classes?: readonly WebsiteSchoolClass[]; formPublicId?: string; bookingPublicId?: string;
}

const PUBLIC_ID = /^[a-f0-9]{48}$/, CLOCK = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
const LITTLE = /little|tiny|tot|mini|ninja|pee ?wee|preschool|cubs?\b|dragons?\b|ages? ?[3-6]\b/i;
const KIDS = /kid|junior|child|youth|teen|tween|school ?age|ages? ?([7-9]|1[0-7])\b/i;
/** Program art follows the name: little ones, kids and teens, or adults. */
function programArt(name: string): WebsiteStarterArt { return LITTLE.test(name) ? 'program-little' : KIDS.test(name) ? 'program-kids' : 'program-adults'; }
function clockLabel(time: string): string {
  const [, h, m] = CLOCK.exec(time)!; const hour = Number(h);
  return `${hour % 12 || 12}:${m} ${hour < 12 ? 'AM' : 'PM'}`;
}
function schoolPrograms(names: readonly string[] | undefined): { name: string; ages: string; description: string; imageUrl: string }[] {
  const seen = new Set<string>(), out: { name: string; ages: string; description: string; imageUrl: string }[] = [];
  for (const raw of names ?? []) {
    const name = clean(typeof raw === 'string' ? raw : '', 80), key = name.toLowerCase();
    if (!name || seen.has(key) || out.length >= 12) continue;
    seen.add(key); out.push({ name, ages: '', description: '', imageUrl: websiteStarterArtUrl(programArt(name)) });
  }
  return out;
}
function schoolSchedule(classes: readonly WebsiteSchoolClass[] | undefined): { day: string; time: string; className: string }[] {
  const rows: { day: number; time: string; className: string }[] = [];
  for (const c of classes ?? []) {
    const name = clean(c && typeof c.name === 'string' ? c.name : '', 80);
    if (!name || !c || typeof c.localStartTime !== 'string' || !CLOCK.test(c.localStartTime) || !Array.isArray(c.weekdays)) continue;
    for (const day of new Set(c.weekdays)) if (Number.isInteger(day) && day >= 1 && day <= 7) rows.push({ day, time: c.localStartTime, className: name });
  }
  rows.sort((a, b) => a.day - b.day || a.time.localeCompare(b.time) || a.className.localeCompare(b.className));
  return rows.slice(0, WEBSITE_MAX_ITEMS).map(r => ({ day: DAYS[r.day - 1]!, time: clockLabel(r.time), className: r.className }));
}
const publicId = (value: string | undefined) => (typeof value === 'string' && PUBLIC_ID.test(value) ? value : '');

const THEMES: Record<WebsiteTemplate, Omit<WebsiteTheme, 'template' | 'logoUrl'>> = {
  MODERN_CLEAN: { font: 'MODERN', palette: { primary: '#1f3a8a', accent: '#f59e0b', background: '#ffffff', surface: '#f3f4f6', text: '#111827' } },
  FAMILY_FRIENDLY: { font: 'FRIENDLY', palette: { primary: '#0f766e', accent: '#fbbf24', background: '#fffdf7', surface: '#fef3c7', text: '#1f2937' } },
  BOLD_POWERFUL: { font: 'BOLD', palette: { primary: '#111111', accent: '#ef4444', background: '#ffffff', surface: '#f1f1f1', text: '#111111' } },
  TRADITIONAL: { font: 'CLASSIC', palette: { primary: '#7f1d1d', accent: '#d4a017', background: '#fbf7f0', surface: '#f1e7d6', text: '#1c1917' } },
  HIGH_CONVERSION: { font: 'MODERN', palette: { primary: '#0b3b5c', accent: '#22c55e', background: '#ffffff', surface: '#eef6fb', text: '#0f172a' } },
  NEON_GRID: { font: 'TECH', palette: { primary: '#7c3aed', accent: '#22d3ee', background: '#05060a', surface: '#11142a', text: '#e8eaf6' } },
  EDITORIAL: { font: 'EDITORIAL', palette: { primary: '#141414', accent: '#e11d48', background: '#f6f4ef', surface: '#ebe6dc', text: '#141414' } },
  BENTO: { font: 'TECH', palette: { primary: '#2563eb', accent: '#f97316', background: '#f1f5f9', surface: '#ffffff', text: '#0f172a' } },
};

/** Section text per template: what the site leads with differs (calm, family, intensity, heritage, sign-up first). */
const COPY: Record<WebsiteTemplate, { hero: string; sub: string; cta: string; trial: string; trialBody: string }> = {
  MODERN_CLEAN: { hero: 'Martial arts at {name}', sub: 'Classes for kids, teens and adults, taught with care.', cta: 'Book a free class', trial: 'Try your first class', trialBody: 'Come see a class and meet the team.' },
  FAMILY_FRIENDLY: { hero: 'Confidence, focus and fun at {name}', sub: 'A friendly place for the whole family to learn, grow and get active together.', cta: 'Try a free family class', trial: 'Your first class is on us', trialBody: 'Bring the kids, wear something comfortable, and we will take care of the rest.' },
  BOLD_POWERFUL: { hero: 'Train hard at {name}', sub: 'Build strength, discipline and real skill.\nEvery class pushes you further.', cta: 'Start training', trial: 'Ready to start?', trialBody: 'Book your first session and feel the difference.' },
  TRADITIONAL: { hero: '{name}', sub: 'Respect, discipline and tradition, passed from instructor to student.', cta: 'Visit the school', trial: 'Begin your journey', trialBody: 'Every black belt was once a beginner. Visit a class to see how we train.' },
  HIGH_CONVERSION: { hero: 'Get your free trial class at {name}', sub: 'Limited spots each week. Book in under a minute.', cta: 'Claim my free class', trial: 'Spots fill up fast', trialBody: 'Pick a time that works for you and we will save your spot.' },
  NEON_GRID: { hero: 'Train for what comes next at {name}', sub: 'Book in seconds, follow your belt progress in the app, and train with coaches who push you further.', cta: 'Start my free trial', trial: 'Your first class is on us', trialBody: 'Pick a time, show up, and we will set up your progress in the app.' },
  EDITORIAL: { hero: 'Discipline, in motion.', sub: '{name}. Martial arts for people who want more than a workout.', cta: 'Visit a class', trial: 'Begin.', trialBody: 'One class is enough to know. Come and see how we train.' },
  BENTO: { hero: 'Your next class is one tap away', sub: 'See this week at {name}, book a spot in seconds and keep track of every class.', cta: 'See this week', trial: 'Try a class free', trialBody: 'New here? Book any beginner class this week at no cost.' },
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const clip = (text: string, max: number) => text.slice(0, max).trim();
const clean = (text: string | undefined, max: number) => clip((text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ').replace(/\s+/g, ' '), max);

/** An empty section of a type, with every field present and blank (layout and provider take their first value). */
export function blankWebsiteSection(type: WebsiteSectionType, id: string): WebsiteSection {
  const spec = WEBSITE_SECTION_SPECS[type] as { fields: Record<string, { kind: string; values?: readonly string[] }>; items?: unknown };
  const props: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(spec.fields)) props[name] = field.kind === 'enum' ? field.values![0] : '';
  if (spec.items) props.items = [];
  return { id, type, props };
}
const section = (type: WebsiteSectionType, id: string, props: Record<string, unknown>): WebsiteSection => {
  const s = blankWebsiteSection(type, id); Object.assign(s.props, props); return s;
};
const page = (slug: string, kind: WebsitePageKind, title: string, sections: WebsiteSection[], inNav = true): WebsitePage =>
  ({ slug, kind, title, inNav, seo: { title: '', description: '' }, campaignId: null, sections });

/**
 * A complete, valid starting site for a template. School facts fill programs, schedule, form and booking; without them
 * the sample programs stay and forms and booking start unconnected for the owner to choose.
 */
export function buildWebsiteFromTemplate(template: WebsiteTemplate, facts: WebsiteSchoolFacts): WebsiteDocument {
  const name = clean(facts.schoolName, 80) || 'Our school', copy = COPY[template];
  const fill = (text: string, max: number) => clip(text.replace('{name}', name), max);
  const email = clean(facts.email, 254);
  const contact = section('CONTACT', 'contact', { heading: 'Visit us', address: clean(facts.address, 300), phone: clean(facts.phone, 40),
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '', hours: '' });
  const hero = section('HERO', 'hero', { heading: fill(copy.hero, 120), subheading: fill(copy.sub, 300), ctaLabel: copy.cta, ctaHref: '#trial', imageUrl: websiteStarterArtUrl(HERO_ART[template]) });
  const known = schoolPrograms(facts.programs), times = schoolSchedule(facts.classes);
  const formId = publicId(facts.formPublicId), bookingId = publicId(facts.bookingPublicId);
  const programs = section('PROGRAMS', 'programs', { heading: 'Programs', intro: '', items: known.length ? known : [
    { name: 'Little Ninjas', ages: 'Ages 4-6', description: 'Listening, balance and confidence through play.', imageUrl: websiteStarterArtUrl('program-little') },
    { name: 'Kids', ages: 'Ages 7-12', description: 'Focus, respect and real technique, one belt at a time.', imageUrl: websiteStarterArtUrl('program-kids') },
    { name: 'Teens and adults', ages: 'Ages 13+', description: 'Fitness, self-defense and skill for every level.', imageUrl: websiteStarterArtUrl('program-adults') }] });
  const trial = section('TRIAL_CTA', 'trial', { heading: copy.trial, body: copy.trialBody,
    ...(bookingId ? { ctaLabel: 'Book a class', ctaHref: '#book' } : { ctaLabel: 'Ask about a class', ctaHref: '#enquire' }) });
  const form = section('LEAD_FORM', 'enquire', { heading: 'Ask us anything', body: 'Leave your details and we will get back to you.', publicFormId: formId });
  const booking = section('BOOKING', 'book', { heading: 'Book a time', body: '', ctaLabel: 'See open times', bookingPublicId: bookingId });
  const faq = section('FAQ', 'faq', { heading: 'Questions', items: [
    { question: 'Do I need experience?', answer: 'No. Most students start as complete beginners.' },
    { question: 'What should I wear?', answer: 'Comfortable workout clothes. We can help with a uniform later.' }] });
  const about = page('about', 'CUSTOM', 'About', [
    section('TEXT', 'story', { heading: `About ${name}`.slice(0, 120), body: 'Tell visitors who you are, how long you have taught, and what makes your school special.' }),
    section('INSTRUCTORS', 'team', { heading: 'Our instructors', items: [] })]);
  const schedule = page('schedule', 'CUSTOM', 'Schedule', [section('SCHEDULE', 'times', { heading: 'Class schedule', note: times.length ? '' : 'Add your weekly classes here.', items: times })]);
  // Conversion looks put the enquiry form right under the hero (an offer band, or beside the hero text in HIGH_CONVERSION).
  const offer = section('LEAD_FORM', 'enquire', { heading: 'Claim your free first class', body: 'Tell us where to reach you and we will help you pick the right class.', publicFormId: formId });
  const home: WebsiteSection[] = template === 'HIGH_CONVERSION'
    ? [section('PROMO_BANNER', 'promo', { text: 'Free trial class for new students', ctaLabel: 'Book now', ctaHref: '#trial' }), hero, offer, programs,
      section('TESTIMONIALS', 'reviews', { heading: 'What families say', items: [] }), trial, booking, faq, contact]
    : template === 'BOLD_POWERFUL' ? [hero, offer, programs, trial, faq, contact]
      : template === 'TRADITIONAL' ? [hero, section('TEXT', 'values', { heading: 'Our values', body: 'Courtesy. Integrity. Perseverance. Self-control.' }), programs, trial, form, contact]
        : template === 'FAMILY_FRIENDLY' ? [hero, programs, section('TESTIMONIALS', 'reviews', { heading: 'What families say', items: [] }), trial, faq, form, contact]
          : template === 'NEON_GRID' ? [section('PROMO_BANNER', 'promo', { text: 'Book online. Track progress in the app.', ctaLabel: 'Start free', ctaHref: '#trial' }), hero, programs,
            section('TEXT', 'how', { heading: 'How it works', body: '1. Book a free class online.\n2. Meet your coach and train.\n3. Follow every class and belt in the app.' }),
            section('TESTIMONIALS', 'reviews', { heading: 'What members say', items: [] }), trial, form, contact]
            : template === 'EDITORIAL' ? [hero, section('TEXT', 'manifesto', { heading: 'Why we train', body: 'Not to fight. To focus, to keep promises to ourselves, and to stay calm when it matters.' }),
              programs, section('TESTIMONIALS', 'reviews', { heading: 'In their words', items: [] }), trial, form, contact]
              : template === 'BENTO' ? [hero, section('SCHEDULE', 'week', { heading: 'This week', note: times.length ? '' : 'Your weekly classes show here.', items: clone(times) }),
                booking, programs, section('TESTIMONIALS', 'reviews', { heading: 'Members say', items: [] }), faq, form, contact]
                : [hero, programs, trial, faq, form, contact];
  // A connected booking page gets its own section just before the contact details (HIGH_CONVERSION already has one).
  if (bookingId && !home.includes(booking)) home.splice(home.indexOf(contact), 0, booking);
  const doc: WebsiteDocument = { schemaVersion: 1, theme: { template, logoUrl: '', ...clone(THEMES[template]) }, pages: [
    { ...page('home', 'HOME', 'Home', home), seo: { title: clip(name, 70), description: clip(fill(copy.sub, 300).replace('\n', ' '), 160) } }, about, schedule] };
  return validateWebsiteDocument(doc);
}

/**
 * What each template is built to do, so an owner can pick by outcome rather than by colour. These are design intents,
 * not measured results: HON never claims a conversion rate for a template.
 */
export const WEBSITE_TEMPLATE_FOCUS = {
  HIGH_CONVERSION: 'CONVERSION', FAMILY_FRIENDLY: 'PARENT_TRUST', MODERN_CLEAN: 'BALANCED', BOLD_POWERFUL: 'BRAND_IMPACT', TRADITIONAL: 'STORY',
  NEON_GRID: 'TECH_SHOWCASE', EDITORIAL: 'DESIGN', BENTO: 'BOOKING',
} as const satisfies Record<WebsiteTemplate, string>;
export type WebsiteTemplateFocus = (typeof WEBSITE_TEMPLATE_FOCUS)[WebsiteTemplate];

/** The fictional school every template demo is built for. Its details are sample text, never a real school's. */
export const WEBSITE_DEMO_SCHOOL = 'Summit Martial Arts';
const DEMO_CLASSES: WebsiteSchoolClass[] = [
  { name: 'Little Ninjas (4-6)', weekdays: [1, 3], localStartTime: '16:00' },
  { name: 'Kids Karate (7-12)', weekdays: [1, 3, 5], localStartTime: '17:00' },
  { name: 'Teen and Adult Karate', weekdays: [2, 4], localStartTime: '19:00' },
  { name: 'Family Class', weekdays: [6], localStartTime: '10:00' },
  { name: 'Open Mat', weekdays: [6], localStartTime: '11:30' },
];
const DEMO_REVIEWS = [
  { quote: 'Our son was shy and now he cannot wait for class. The instructors know every child by name.', author: 'Sample parent review' },
  { quote: 'I started at 41 with zero experience. Six months in I am fitter and calmer than I have been in years.', author: 'Sample adult student review' },
  { quote: 'Booking the free class took a minute and they called us the same day.', author: 'Sample parent review' },
];
const DEMO_TEAM = [
  { name: 'Head Instructor', title: '5th degree black belt', bio: 'Your head instructor\'s story, rank and teaching years go here.', imageUrl: '' },
  { name: 'Kids Program Lead', title: '3rd degree black belt', bio: 'Who leads the kids classes and what parents love about them.', imageUrl: '' },
];

/**
 * A template as a complete demo site for a sample school, for the owner to look through before choosing. Every page is
 * filled (programs, weekly schedule, reviews, instructors, contact); reviews and team are labelled as samples. The site
 * an owner creates starts from the same structure with their own details instead.
 */
export function buildWebsiteTemplateDemo(template: WebsiteTemplate): WebsiteDocument {
  const doc = buildWebsiteFromTemplate(template, { schoolName: WEBSITE_DEMO_SCHOOL, phone: '(555) 010-0199', email: 'hello@example.com',
    address: '100 Main Street, Your City', classes: DEMO_CLASSES });
  for (const page of doc.pages) for (const s of page.sections) {
    if (s.type === 'TESTIMONIALS') s.props.items = clone(DEMO_REVIEWS);
    if (s.type === 'INSTRUCTORS') s.props.items = clone(DEMO_TEAM);
    if (s.type === 'CONTACT') s.props.hours = 'Mon-Fri 3:30 PM - 8:30 PM\nSat 9:30 AM - 1:00 PM';
    if (s.type === 'TEXT' && s.id === 'story') s.props.body = 'Summit Martial Arts is a sample school. This is where your story goes: when you opened, who you teach, and what a first class feels like.';
  }
  return validateWebsiteDocument(doc);
}

/** A web address suggestion from a school name: lower case, hyphens, 3 to 48 characters. */
export function suggestWebsiteSlug(name: string): string {
  const s = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '');
  return s.length >= 3 ? s : (s + '-dojo').replace(/^-/, '');
}

/**
 * The closed edit operations. Each returns a new document (the input is not changed) or throws when the operation does
 * not fit; the result is always re-validated as a whole, so an edit can never produce a document the server refuses.
 */
export type WebsiteEdit =
  | { op: 'setSectionProp'; page: string; section: string; prop: string; value: unknown }
  | { op: 'addSection'; page: string; type: WebsiteSectionType; after: string | null }
  | { op: 'removeSection'; page: string; section: string }
  | { op: 'moveSection'; page: string; section: string; by: -1 | 1 }
  | { op: 'addPage'; slug: string; title: string; kind: Exclude<WebsitePageKind, 'HOME'> }
  | { op: 'removePage'; page: string }
  | { op: 'setPage'; page: string; title: string; inNav: boolean; seo: { title: string; description: string } }
  | { op: 'setTheme'; theme: Partial<Omit<WebsiteTheme, 'palette'>> & { palette?: Partial<WebsiteTheme['palette']> } };

function find(doc: WebsiteDocument, slug: string): WebsitePage {
  const p = doc.pages.find(x => x.slug === slug); if (!p) throw new Error('Invalid website edit.'); return p;
}
function freshId(p: WebsitePage, type: WebsiteSectionType): string {
  const base = type.toLowerCase().replace(/_/g, '-'); let id = base, n = 2;
  while (p.sections.some(s => s.id === id)) id = `${base}-${n++}`;
  if (!WEBSITE_SECTION_ID.test(id)) throw new Error('Invalid website edit.');
  return id;
}

export function applyWebsiteEdit(document: WebsiteDocument, edit: WebsiteEdit): WebsiteDocument {
  const doc = clone(document);
  switch (edit.op) {
    case 'setSectionProp': {
      const s = find(doc, edit.page).sections.find(x => x.id === edit.section);
      if (!s || !Object.hasOwn(s.props, edit.prop)) throw new Error('Invalid website edit.');
      s.props[edit.prop] = clone(edit.value); break;
    }
    case 'addSection': {
      const p = find(doc, edit.page);
      if (p.sections.length >= WEBSITE_MAX_SECTIONS) throw new Error('Invalid website edit.');
      const at = edit.after === null ? p.sections.length : p.sections.findIndex(x => x.id === edit.after) + 1;
      if (at < 1 && edit.after !== null) throw new Error('Invalid website edit.');
      p.sections.splice(at, 0, blankWebsiteSection(edit.type, freshId(p, edit.type))); break;
    }
    case 'removeSection': {
      const p = find(doc, edit.page), i = p.sections.findIndex(x => x.id === edit.section);
      if (i < 0 || p.sections.length === 1) throw new Error('Invalid website edit.');
      p.sections.splice(i, 1); break;
    }
    case 'moveSection': {
      const p = find(doc, edit.page), i = p.sections.findIndex(x => x.id === edit.section), j = i + edit.by;
      if (i < 0 || j < 0 || j >= p.sections.length) throw new Error('Invalid website edit.');
      [p.sections[i], p.sections[j]] = [p.sections[j]!, p.sections[i]!]; break;
    }
    case 'addPage': {
      if (doc.pages.length >= WEBSITE_MAX_PAGES || !WEBSITE_PAGE_SLUG.test(edit.slug) || websiteBuiltInPageSlug(edit.slug) || doc.pages.some(p => p.slug === edit.slug)) throw new Error('Invalid website edit.');
      doc.pages.push(page(edit.slug, edit.kind, edit.title, [section('HERO', 'hero', { heading: edit.title })], edit.kind === 'PROGRAM' || edit.kind === 'CUSTOM')); break;
    }
    case 'removePage': {
      if (edit.page === 'home') throw new Error('Invalid website edit.');
      const i = doc.pages.findIndex(p => p.slug === edit.page); if (i < 0) throw new Error('Invalid website edit.');
      doc.pages.splice(i, 1);
      // Links to the removed page become empty rather than broken.
      for (const p of doc.pages) for (const s of p.sections) for (const [k, field] of Object.entries((WEBSITE_SECTION_SPECS[s.type] as { fields: Record<string, { kind: string }> }).fields))
        if (field.kind === 'href' && s.props[k] === '/' + edit.page) s.props[k] = '';
      break;
    }
    case 'setPage': {
      const p = find(doc, edit.page); p.title = edit.title; p.inNav = edit.inNav; p.seo = { title: edit.seo.title, description: edit.seo.description }; break;
    }
    case 'setTheme': {
      const { palette, ...rest } = edit.theme;
      Object.assign(doc.theme, rest); if (palette) Object.assign(doc.theme.palette, palette); break;
    }
    default: throw new Error('Invalid website edit.');
  }
  return validateWebsiteDocument(doc);
}
