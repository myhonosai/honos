import { familyInviteLink, type FamilyInvitationEmailLanguage } from '@hon/contracts';

/**
 * 0714: the family app invitation email. One button opens the HON page that holds the invitation; the parent signs in
 * with this same email there and presses Activate. The link alone gives nobody access: accepting still needs a
 * HON-verified sign-in with the invited address (0205).
 */
export function familyInviteOrigin(value: string | undefined): string | null {
  if (!value) return null;
  return /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(value) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(value) ? value : null;
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
/** One line, no control characters, at most 80 characters: safe in a subject and a sentence. */
const plainName = (name: string) => name.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Your school';

type Wording = { subject: (school: string) => string; lead: (school: string) => string; button: string; steps: readonly [string, string, string]; expires: (date: string) => string; ignore: string; fallback: string };
const WORDING: Record<FamilyInvitationEmailLanguage, Wording> = {
  en: {
    subject: school => `${school} invited you to the HON Family app`,
    lead: school => `${school} invited you to follow your family's classes, messages and progress in the HON Family app.`,
    button: 'Activate my family access',
    steps: ['Press the button below.', 'Sign in or create your account with this email address, then press Activate.', 'Open the HON Family app and sign in with the same email.'],
    expires: date => `This invitation works until ${date}.`,
    ignore: 'If you were not expecting this, you can ignore this email. Nothing happens unless you activate it.',
    fallback: 'If the button does not work, copy this link into your browser:',
  },
  ko: {
    subject: school => `${school}에서 HON Family 앱에 초대했습니다`,
    lead: school => `${school}에서 HON Family 앱으로 가족의 수업, 메시지, 진도를 확인하실 수 있도록 초대했습니다.`,
    button: '가족 이용 활성화하기',
    steps: ['아래 버튼을 누르세요.', '이 이메일 주소로 로그인하거나 계정을 만든 뒤 활성화를 누르세요.', 'HON Family 앱을 열고 같은 이메일로 로그인하세요.'],
    expires: date => `이 초대는 ${date}까지 사용할 수 있습니다.`,
    ignore: '요청하지 않은 초대라면 이 이메일을 무시하셔도 됩니다. 활성화하지 않으면 아무 일도 일어나지 않습니다.',
    fallback: '버튼이 작동하지 않으면 이 링크를 브라우저에 붙여 넣으세요:',
  },
  es: {
    subject: school => `${school} te invitó a la app HON Family`,
    lead: school => `${school} te invitó a seguir las clases, los mensajes y el progreso de tu familia en la app HON Family.`,
    button: 'Activar mi acceso familiar',
    steps: ['Pulsa el botón de abajo.', 'Inicia sesión o crea tu cuenta con este correo y pulsa Activar.', 'Abre la app HON Family e inicia sesión con el mismo correo.'],
    expires: date => `Esta invitación funciona hasta el ${date}.`,
    ignore: 'Si no esperabas esto, puedes ignorar este correo. No pasa nada a menos que lo actives.',
    fallback: 'Si el botón no funciona, copia este enlace en tu navegador:',
  },
};
const LOCALE: Record<FamilyInvitationEmailLanguage, string> = { en: 'en-US', ko: 'ko-KR', es: 'es-US' };

export function familyInvitationEmail(input: { origin: string; invitationId: string; token: string; schoolName: string; expiresAt: string; language: FamilyInvitationEmailLanguage }):
  { subject: string; text: string; html: string; link: string } {
  const w = WORDING[input.language], school = plainName(input.schoolName);
  const link = familyInviteLink(input.origin, input.invitationId, input.token);
  // The day is given in UTC so the email never depends on where the server runs.
  const date = new Intl.DateTimeFormat(LOCALE[input.language], { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(input.expiresAt));
  const text = [w.lead(school), '', ...w.steps.map((step, n) => `${n + 1}. ${step}`), '', `${w.button}: ${link}`, '', w.expires(date), w.ignore].join('\n');
  const html = `<!doctype html><html lang="${input.language}"><body style="margin:0;padding:24px;background:#f4f6fb;font-family:Arial,Helvetica,sans-serif;color:#111827">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:28px">`
    + `<tr><td style="font-size:16px;line-height:24px">${escapeHtml(w.lead(school))}</td></tr>`
    + `<tr><td style="padding:16px 0 4px;font-size:15px;line-height:24px"><ol style="margin:0;padding-left:20px">${w.steps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol></td></tr>`
    + `<tr><td align="center" style="padding:20px 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;font-weight:bold;font-size:16px;padding:14px 26px;border-radius:8px">${escapeHtml(w.button)}</a></td></tr>`
    + `<tr><td style="font-size:13px;line-height:20px;color:#4b5563">${escapeHtml(w.expires(date))}<br>${escapeHtml(w.ignore)}</td></tr>`
    + `<tr><td style="padding-top:16px;font-size:12px;line-height:18px;color:#6b7280;word-break:break-all">${escapeHtml(w.fallback)}<br>${escapeHtml(link)}</td></tr>`
    + `</table></td></tr></table></body></html>`;
  return { subject: w.subject(school).slice(0, 150), text, html, link };
}
