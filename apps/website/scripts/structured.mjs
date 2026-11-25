// Structured data (Schema.org JSON-LD) and /llms.txt for the HON OS marketing site.
// Everything here mirrors what the built pages already show people: the FAQ is read from the page's
// own <details> questions, prices come from PLANS (and a test checks the page shows the same prices),
// and blog facts come from each post's front matter. Nothing is invented for search engines or AI.

export const ORG = {
  name: 'HON OS',
  legalName: 'HON OS Labs LLC',
  description: 'HON OS is one app for running and growing a martial arts school: leads, students, classes, belt testing, tuition and marketing, with an AI team included in the subscription.',
};

/** Public prices exactly as the pricing section shows them (USD). */
export const PLANS = [
  { id: 'standard-monthly', name: 'HON OS, monthly', price: '249.00', shown: '$249', duration: 'P1M', unit: 'MON' },
  { id: 'standard-yearly', name: 'HON OS, yearly', price: '2097.00', shown: '$2,097', duration: 'P1Y', unit: 'ANN' },
  { id: 'founder-monthly', name: 'Founder 50, monthly (first 50 schools)', price: '199.20', shown: '$199.20', duration: 'P1M', unit: 'MON' },
  { id: 'founder-yearly', name: 'Founder 50, yearly (first 50 schools)', price: '1494.00', shown: '$1,494', duration: 'P1Y', unit: 'ANN' },
];

const decode = (s) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** The FAQ questions and answers a page shows, in page order: [{ q, a }]. */
export function faqFromHtml(html) {
  const sec = html.match(/<section id="faq"[\s\S]*?<\/section>/)?.[0] ?? '';
  return [...sec.matchAll(/<details[^>]*><summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g)]
    .map((m) => ({ q: decode(m[1]), a: decode(m[2]) }));
}

export const ids = (origin) => ({ org: `${origin}/#org`, site: `${origin}/#site`, app: `${origin}/#software` });

function orgNode(origin) {
  return {
    '@type': 'Organization', '@id': ids(origin).org, name: ORG.name, legalName: ORG.legalName, url: `${origin}/`,
    logo: { '@type': 'ImageObject', url: `${origin}/apple-touch-icon.png`, width: 180, height: 180 },
    description: ORG.description, knowsLanguage: ['en', 'ko', 'es'],
  };
}

function breadcrumbs(items) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, item], i) => ({ '@type': 'ListItem', position: i + 1, name, item })),
  };
}

function webPage({ origin, path, lang, title, description, type = 'WebPage' }) {
  return {
    '@type': type, '@id': `${origin}${path}#webpage`, url: `${origin}${path}`, name: title, description,
    inLanguage: lang, isPartOf: { '@id': ids(origin).site }, publisher: { '@id': ids(origin).org },
  };
}

/**
 * The JSON-LD @graph for one built page.
 * kind: 'home' | 'blog-index' | 'post' | 'legal'. html is the page as built (used for its title,
 * description and FAQ). post: { title, description, date, author } for kind 'post'.
 */
export function pageGraph({ kind, origin, path, lang, html, post, homeName = 'HON OS', blogName = 'Blog', app }) {
  const title = decode(html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? 'HON OS');
  const description = decode(html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '');
  const root = lang === 'en' ? '/' : `/${lang}/`;
  const graph = [];
  if (kind === 'home') {
    graph.push(orgNode(origin));
    graph.push({ '@type': 'WebSite', '@id': ids(origin).site, name: 'HON OS', url: `${origin}/`, inLanguage: ['en', 'ko', 'es'], publisher: { '@id': ids(origin).org } });
    graph.push({ ...webPage({ origin, path, lang, title, description }), about: { '@id': ids(origin).app } });
    graph.push({
      '@type': 'SoftwareApplication', '@id': ids(origin).app, name: 'HON OS', applicationCategory: 'BusinessApplication',
      applicationSubCategory: 'Martial arts school management software', operatingSystem: 'Web',
      description: ORG.description, url: `${origin}/`, publisher: { '@id': ids(origin).org }, inLanguage: ['en', 'ko', 'es'],
      offers: PLANS.map((p) => ({
        '@type': 'Offer', '@id': `${origin}/#offer-${p.id}`, name: p.name, price: p.price, priceCurrency: 'USD',
        url: `${origin}${root}#pricing`,
        priceSpecification: { '@type': 'UnitPriceSpecification', price: p.price, priceCurrency: 'USD', billingDuration: p.duration, unitCode: p.unit },
      })),
    });
    const faq = faqFromHtml(html);
    if (faq.length) {
      graph.push({
        '@type': 'FAQPage', '@id': `${origin}${path}#faq`, url: `${origin}${path}#faq`, inLanguage: lang, isPartOf: { '@id': `${origin}${path}#webpage` },
        mainEntity: faq.map(({ q, a }) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
      });
    }
  } else if (kind === 'blog-index') {
    graph.push({ ...webPage({ origin, path, lang, title, description, type: 'CollectionPage' }) });
    graph.push({ '@type': 'Blog', '@id': `${origin}${path}#blog`, name: title.replace(/ \| HON OS$/, ''), url: `${origin}${path}`, inLanguage: lang, publisher: { '@id': ids(origin).org } });
    graph.push(breadcrumbs([[homeName, `${origin}${root}`], [blogName, `${origin}${path}`]]));
  } else if (kind === 'post') {
    const blogPath = `${root}blog/`;
    graph.push({ ...webPage({ origin, path, lang, title, description }) });
    graph.push({
      '@type': 'BlogPosting', '@id': `${origin}${path}#article`, headline: post.title, description: post.description,
      datePublished: post.date, inLanguage: lang, url: `${origin}${path}`, mainEntityOfPage: { '@id': `${origin}${path}#webpage` },
      isPartOf: { '@id': `${origin}${blogPath}#blog` }, image: `${origin}/assets/og-hon-os-1200.jpg`,
      author: { '@type': 'Organization', name: post.author, url: `${origin}/` }, publisher: { '@id': ids(origin).org },
    });
    graph.push(breadcrumbs([[homeName, `${origin}${root}`], [blogName, `${origin}${blogPath}`], [post.title, `${origin}${path}`]]));
  } else if (kind === 'legal') {
    graph.push(webPage({ origin, path, lang, title, description }));
    graph.push(breadcrumbs([[homeName, `${origin}/`], [title.replace(/ \| HON OS$/, ''), `${origin}${path}`]]));
  } else {
    throw new Error(`unknown page kind ${kind}`);
  }
  return JSON.parse(JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }));
}

/** A JSON-LD data block. The Content-Security-Policy does not run it, and "<" is escaped so it can't end the tag. */
export function jsonLdTag(data) {
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

/**
 * /llms.txt (https://llmstxt.org): a short Markdown guide to the site for AI tools, built from the
 * English home page, the blog and the legal pages so it can't drift from what the site says.
 */
export function llmsTxt({ origin, app, homeHtml, posts, legal }) {
  const faq = faqFromHtml(homeHtml);
  const price = (id) => PLANS.find((p) => p.id === id).shown;
  const lines = [
    '# HON OS',
    '',
    `> ${ORG.description}`,
    '',
    'HON OS is made by HON OS Labs LLC for martial arts school owners and their staff. It is sold as one plan. The site and the app are available in English, Korean and Spanish.',
    '',
    '## Key facts',
    '',
    `- Price: ${price('standard-monthly')} per month, or ${price('standard-yearly')} per year.`,
    `- Founder 50: the first 50 schools pay ${price('founder-monthly')} per month or ${price('founder-yearly')} per year for as long as they stay subscribed.`,
    '- Free trial: 14 days, with no automatic charge when it ends.',
    '- Money-back guarantee: ask within 30 days of the first HON OS payment for a full refund of that payment.',
    '- HON takes no fee on tuition; schools connect their own Stripe or Square account.',
    `- Pricing details: ${origin}/#pricing`,
    '',
    '## Main pages',
    '',
    `- [HON OS home (English)](${origin}/): what HON OS does, the AI team, payments, marketing, pricing and FAQ`,
    `- [HON OS en español](${origin}/es/): the home page in Spanish`,
    `- [HON OS 한국어](${origin}/ko/): the home page in Korean`,
    `- [Start a new school](${app}/account/start): sign up for the free trial`,
    `- [Sign in](${app}/auth/login): for schools already using HON OS`,
    '',
    '## Frequently asked questions',
    '',
    ...faq.map(({ q, a }) => `- **${q}** ${a}`),
    '',
    '## Blog',
    '',
    `- [The HON OS blog](${origin}/blog/): practical ideas for martial arts school owners`,
    ...posts.map((p) => `- [${p.title}](${origin}/blog/${p.slug}/): ${p.description}`),
    '',
    '## Optional',
    '',
    ...legal.map((l) => `- [${l.title}](${origin}/${l.slug}/): ${l.description}`),
    '',
  ];
  return lines.join('\n');
}
