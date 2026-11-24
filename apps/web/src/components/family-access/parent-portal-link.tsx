'use client';
import React, { useEffect, useState } from 'react';
import { useLocale } from '../localization/provider';
import styles from './workbench.module.css';

type Key = 'title' | 'intro' | 'link' | 'copyLink' | 'button' | 'copyButton' | 'buttonLabel' | 'copied' | 'copyFailed' | 'how';
const en: Record<Key, string> = {
  title: 'Parent portal link',
  intro: 'Put this link on your school website so families can open the parent portal. It is the same for every family; nothing private is in it.',
  link: 'Link', copyLink: 'Copy link', button: 'Website button (HTML)', copyButton: 'Copy button code', buttonLabel: 'Parent portal',
  copied: 'Copied.', copyFailed: 'Copy did not work here. Select the text and copy it yourself.',
  how: 'A parent can see their family only after you invite them below and they accept the invitation. The link alone opens no family information.',
};
const ko: Record<Key, string> = {
  title: '학부모 포털 링크',
  intro: '가족이 학부모 포털을 열 수 있도록 이 링크를 학교 웹사이트에 넣으세요. 모든 가족에게 같은 링크이며 개인 정보는 들어 있지 않습니다.',
  link: '링크', copyLink: '링크 복사', button: '웹사이트 버튼 (HTML)', copyButton: '버튼 코드 복사', buttonLabel: '학부모 포털',
  copied: '복사했습니다.', copyFailed: '여기서는 복사가 되지 않았습니다. 텍스트를 선택해 직접 복사하세요.',
  how: '아래에서 초대하고 학부모가 초대를 수락해야 가족 정보를 볼 수 있습니다. 링크만으로는 가족 정보가 열리지 않습니다.',
};
const es: Record<Key, string> = {
  title: 'Enlace del portal para padres',
  intro: 'Pon este enlace en el sitio web de tu escuela para que las familias abran el portal para padres. Es el mismo para todas las familias y no contiene nada privado.',
  link: 'Enlace', copyLink: 'Copiar enlace', button: 'Botón para el sitio web (HTML)', copyButton: 'Copiar código del botón', buttonLabel: 'Portal para padres',
  copied: 'Copiado.', copyFailed: 'No se pudo copiar aquí. Selecciona el texto y cópialo tú.',
  how: 'Un padre solo ve a su familia después de que lo invites abajo y acepte la invitación. El enlace por sí solo no abre información familiar.',
};
export function parentPortalText(language: string, key: Key): string { return (language === 'ko' ? ko : language === 'es' ? es : en)[key]; }

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** The portal address on the site staff are using now; it carries no school, family or person. */
export function parentPortalUrl(origin: string): string { return `${new URL(origin).origin}/parent`; }
/** A plain link for a school website: nothing framed, no script. */
export function parentPortalButton(link: string, label: string): string {
  return `<a href="${escapeHtml(link)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
}

/** `origin` is only for rendering outside a browser (tests); in the app it comes from the page itself. */
export function ParentPortalLink({ origin }: { origin?: string } = {}): React.ReactElement {
  const locale = useLocale(), t = (key: Key) => parentPortalText(locale.preferences.language, key);
  const [link, setLink] = useState(() => { try { return origin ? parentPortalUrl(origin) : ''; } catch { return ''; } }), [copied, setCopied] = useState<'' | 'link' | 'button' | 'failed'>('');
  useEffect(() => { try { setLink(parentPortalUrl(window.location.origin)); } catch { setLink(''); } }, []);
  const button = link ? parentPortalButton(link, t('buttonLabel')) : '';
  const copy = async (kind: 'link' | 'button', text: string) => {
    try { if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable'); await navigator.clipboard.writeText(text); setCopied(kind); }
    catch { setCopied('failed'); }
  };
  return <section className={styles.notice} aria-labelledby="parent-portal-link-title" data-testid="parent-portal-link">
    <h2 id="parent-portal-link-title">{t('title')}</h2><p>{t('intro')}</p>
    {link && <>
      <label>{t('link')}<input readOnly autoComplete="off" value={link} data-testid="parent-portal-url" onFocus={e => e.currentTarget.select()} /></label>
      <button type="button" onClick={() => void copy('link', link)}>{t('copyLink')}</button>
      <label>{t('button')}<input readOnly autoComplete="off" value={button} data-testid="parent-portal-button" onFocus={e => e.currentTarget.select()} /></label>
      <button type="button" onClick={() => void copy('button', button)}>{t('copyButton')}</button>
    </>}
    <p role="status" aria-live="polite">{copied === 'failed' ? t('copyFailed') : copied ? t('copied') : ''}</p>
    <p>{t('how')}</p>
  </section>;
}
