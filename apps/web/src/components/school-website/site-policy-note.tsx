import React from 'react';
import { findSiteContact, siteContactReachable, type WebsiteDocument } from '@hon/contracts';
import styles from './website.module.css';

/**
 * A2P step 2: tells the owner that HON adds a privacy policy and terms page to the site, and warns when the site has no
 * Contact block with an email or phone, because carriers reject texting registrations whose policy gives no way to reach
 * the school. Wording only; the pages themselves are built on the public site.
 */
const COPY = {
  en: { title: 'Privacy policy and terms', body: 'HON adds a privacy policy and terms page to your website automatically, with the text message rules phone carriers check before they approve your school\'s texting. Every page links to them at the bottom.',
    warn: 'Add a Contact section with your email or phone number. Your privacy policy uses it so families and carriers can reach you.', privacy: 'Open privacy policy', terms: 'Open terms',
    review: 'This is a starting policy for you to review. It is not legal advice.' },
  ko: { title: '개인정보 처리방침 및 이용약관', body: 'HON이 웹사이트에 개인정보 처리방침과 이용약관 페이지를 자동으로 추가합니다. 통신사가 학교 문자 등록을 승인하기 전에 확인하는 문자 규정이 포함되어 있으며, 모든 페이지 하단에 링크가 있습니다.',
    warn: '이메일이나 전화번호가 있는 연락처 섹션을 추가하세요. 학부모와 통신사가 학교에 연락할 수 있도록 개인정보 처리방침에 사용됩니다.', privacy: '개인정보 처리방침 열기', terms: '이용약관 열기',
    review: '검토용 기본 방침이며 법률 자문이 아닙니다.' },
  es: { title: 'Política de privacidad y términos', body: 'HON agrega automáticamente a su sitio una página de política de privacidad y otra de términos, con las reglas de mensajes de texto que las operadoras revisan antes de aprobar los textos de su escuela. Cada página las enlaza al final.',
    warn: 'Agregue una sección de Contacto con su correo o teléfono. Su política de privacidad la usa para que las familias y las operadoras puedan comunicarse con usted.', privacy: 'Abrir política de privacidad', terms: 'Abrir términos',
    review: 'Es una política inicial para que usted la revise. No es asesoría legal.' },
} as const;

export function SitePolicyNote({ language, document, slug, published }: { language: string; document: WebsiteDocument; slug: string; published: boolean }) {
  const t = COPY[(language === 'ko' || language === 'es' ? language : 'en') as keyof typeof COPY];
  const reachable = siteContactReachable(findSiteContact(document));
  return <section className={styles.card} aria-labelledby="site-policies"><h2 id="site-policies">{t.title}</h2>
    <p className={styles.meta}>{t.body}</p>
    {!reachable && <p className={styles.warnText} data-warn="">{t.warn}</p>}
    {published && <div className={styles.row}><a className={styles.secondary} href={`/sites/${slug}/privacy`} target="_blank" rel="noopener noreferrer">{t.privacy}</a>
      <a className={styles.secondary} href={`/sites/${slug}/terms`} target="_blank" rel="noopener noreferrer">{t.terms}</a></div>}
    <p className={styles.meta}>{t.review}</p>
  </section>;
}
