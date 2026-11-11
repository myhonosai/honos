'use client';
import React from 'react';
import { useLocale } from '../localization/provider';
import styles from './home-landing.module.css';

const copy = {
  en: { tagline: 'The AI-powered operating system built to run and grow martial arts schools.', signIn: 'Sign in', continue: 'Open my workspace', help: 'Use the account your school or HON invited. Your workspace and permissions are checked after you sign in.' },
  ko: { tagline: '무술 도장의 운영과 성장을 위한 AI 기반 운영 시스템입니다.', signIn: '로그인', continue: '내 업무 공간 열기', help: '도장 또는 HON에서 초대받은 계정을 사용하세요. 로그인 후 업무 공간과 권한을 확인합니다.' },
  es: { tagline: 'El sistema operativo con IA creado para dirigir y hacer crecer escuelas de artes marciales.', signIn: 'Iniciar sesión', continue: 'Abrir mi espacio', help: 'Usa la cuenta con la que te invitó tu escuela o HON. Tu espacio y tus permisos se comprueban después de iniciar sesión.' },
};

export function HomeLanding(): React.ReactElement {
  const { preferences } = useLocale(), t = copy[preferences.language];
  return <main className={styles.page} data-hon-home><div className={styles.inner}>
    <p className={styles.brand}>HON OS</p>
    <h1>{t.tagline}</h1>
    <nav className={styles.actions} aria-label="HON OS">
      <a className={styles.primary} href="/auth/login">{t.signIn}</a>
      <a href="/auth/continue">{t.continue}</a>
    </nav>
    <p className={styles.help}>{t.help}</p>
  </div></main>;
}
