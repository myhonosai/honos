'use client';
import React from 'react';
import { useLocale } from '../localization/provider';
import { entryText } from './copy';
import styles from '../../app/auth/access/page.module.css';

const copy = {
  en: { title: 'Access not verified', help: 'We could not verify a starting workspace. Access may need review or verification may be temporarily unavailable.', boundary: 'This does not establish that your account has no access. Each workspace independently checks its current permissions.', nav: 'Workspace navigation', hq: 'Open HQ', staff: 'Open school workspace', parent: 'Open Parent Home', parentHelp: 'If you normally use Parent Home, you can open it directly. Your family access is checked there.', verify: 'Try access verification again', login: 'Sign in again' },
  ko: { title: '접근 권한 미확인', help: '시작할 업무 공간을 확인할 수 없습니다. 접근 권한 검토가 필요하거나 일시적으로 확인할 수 없을 수 있습니다.', boundary: '접근 권한이 없다는 뜻은 아닙니다. 각 업무 공간에서 현재 권한을 별도로 확인합니다.', nav: '업무 공간 탐색', hq: 'HQ 열기', staff: '도장 업무 공간 열기', parent: '학부모 홈 열기', parentHelp: '평소 학부모 홈을 이용한다면 직접 열 수 있습니다. 해당 화면에서 가족 접근 권한을 확인합니다.', verify: '접근 권한 다시 확인', login: '다시 로그인' },
  es: { title: 'Acceso sin verificar', help: 'No se pudo verificar un espacio inicial. El acceso puede requerir revisión o la verificación puede no estar disponible temporalmente.', boundary: 'Esto no significa que tu cuenta no tenga acceso. Cada espacio comprueba sus permisos actuales de forma independiente.', nav: 'Navegación del espacio', hq: 'Abrir HQ', staff: 'Abrir espacio escolar', parent: 'Abrir inicio de familias', parentHelp: 'Si utilizas el inicio de familias, puedes abrirlo directamente. Allí se verifica tu acceso familiar.', verify: 'Volver a verificar el acceso', login: 'Volver a iniciar sesión' },
};
export function AccessNotice(): React.ReactElement {
  const { preferences } = useLocale(), t = copy[preferences.language];
  return <main className={styles.page}><p>HON OS</p><h1>{t.title}</h1><p>{t.help}</p><p>{t.boundary}</p>
    <nav aria-label={t.nav}><a href="/hq">{t.hq}</a><a href="/staff/entry">{t.staff}</a><a href="/parent">{t.parent}</a><a href="/staff/account-status">{entryText(preferences.language, 'account')}</a></nav>
    <p>{t.parentHelp}</p><a href="/auth/continue">{t.verify}</a><a href="/auth/login">{t.login}</a></main>;
}
