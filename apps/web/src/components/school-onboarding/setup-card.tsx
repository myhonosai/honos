'use client';
import React, { useEffect, useState } from 'react';
import { onboardingApi } from './http';
import { progressOf } from './plan';
import styles from './setup-card.module.css';

/**
 * Home's way into onboarding (owner, 2026-11-14: setup lives in onboarding, not Settings). Shown only while the
 * server reports required setup steps still open; hidden while loading, on any error and once setup is done.
 */
const COPY: Record<string, { title: string; line: string; open: string }> = {
  en: { title: 'Finish setting up your school', line: '{done} of {total} setup steps done.', open: 'Continue setup' },
  ko: { title: '도장 설정을 마무리하세요', line: '설정 단계 {total}개 중 {done}개 완료.', open: '설정 계속하기' },
  es: { title: 'Termina de configurar tu escuela', line: '{done} de {total} pasos de configuración listos.', open: 'Continuar la configuración' },
};
export function SetupCardView({ language, done, total }: { language: string; done: number; total: number }): React.ReactElement | null {
  if (total === 0 || done >= total) return null;
  const c = COPY[language] ?? COPY.en!;
  return <aside className={styles.card} data-setup-card="">
    <div><strong>{c.title}</strong><span>{c.line.replace('{done}', String(done)).replace('{total}', String(total))}</span></div>
    <a href="/staff/welcome">{c.open}<span aria-hidden="true"> →</span></a>
  </aside>;
}
export function SetupCard({ scope, language }: { scope: Readonly<{ organizationId: string; schoolId: string }> | null; language: string }): React.ReactElement | null {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    setProgress(null);
    if (!scope) return;
    let current = true; const abort = new AbortController();
    onboardingApi.read(scope, abort.signal, () => current).then(o => { if (current) setProgress(progressOf(o)); }, () => { /* hidden on any failure */ });
    return () => { current = false; abort.abort(); };
  }, [scope?.organizationId, scope?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps
  return progress ? <SetupCardView language={language} done={progress.done} total={progress.total} /> : null;
}
