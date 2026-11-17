/** Ads page wording (en / ko / es). Labels only; nothing here is authority or an outcome. */
const en = {
  title: 'Ads', intro: 'Connect Meta Ads and Google Ads for your school, and let Marcus, your marketing specialist, help set up each ad. A person approves every ad and turns it on.',
  waiting: 'Checking your school…', noSchool: 'Choose a school to see its ads.', concealed: 'Hidden while you were away. It shows again once your school is checked.',
  loading: 'Reading your ad connections…', denied: 'You cannot see this school\'s ad connections. Ask the school owner for access.', unavailable: 'Your ad connections could not be loaded.', refresh: 'Check again',
  metaTitle: 'Meta Ads', metaHelp: 'Facebook and Instagram ads run from your school\'s Facebook Page, connected through Zernio. Your Meta ad account pays Meta directly; HON never holds or marks up ad money.',
  meta_NOT_CONNECTED: 'Not connected. Connect your Facebook Page first.', meta_CONNECTED_ADS_OFF: 'Facebook connected. Ads are off for every Page; turn ads on for a Page on Social accounts.',
  meta_READY_FOR_ADS: 'Facebook connected, with ads on for at least one Page.',
  connectMeta: 'Connect Facebook for Meta Ads', connecting: 'Opening…', connectHelp: 'You sign in with Facebook on its own page, then come back to HON.',
  connectOff: 'Connecting ad accounts is not turned on for HON OS yet. Nothing has been connected.',
  adsOn: 'Ads on', adsOff: 'Ads off', changeOnSocial: 'Change on Social accounts',
  metaNext: 'Creating and running Meta ads arrives in the next update: you set a monthly ad spend limit, every ad starts paused, and a person turns it on.',
  googleTitle: 'Google Ads', googleStatus: 'Not available yet.',
  googleHelp: 'Google Ads will connect through the same secure connection (Zernio) in a later update, with the same monthly limit and the same human approval. Nothing is connected or charged today.',
  aiTitle: 'Set up an ad with AI', aiHelp: 'Marcus can write your ad text today: pick a campaign, describe the ad, and Marcus drafts it. A person approves every draft before it is saved.',
  aiNext: 'Next, Marcus will also suggest which post to promote, the budget inside your limit and the dates. You review and approve; nothing runs on its own.',
  openMarcus: 'Ask Marcus for an ad', openCampaigns: 'Campaign planner',
  e_DENIED: 'You are not allowed to connect accounts at this school. Nothing changed.', e_NOT_ENABLED: 'Connecting is not turned on for HON OS yet. Nothing changed.',
  e_LIMIT: 'Too many attempts. Try later. Nothing changed.', e_PROVIDER: 'Zernio did not answer. Nothing was connected. Start again.',
  e_INVALID: 'This was not accepted. Nothing changed.', e_UNKNOWN: 'We could not confirm whether the connection started. Start again; an unused link expires by itself.',
};
export type AdsKey = keyof typeof en;
export const ADS_KEYS = Object.keys(en) as AdsKey[];
const ko: Record<AdsKey, string> = {
  title: '광고', intro: '도장의 Meta 광고와 Google 광고를 연결하고, 마케팅 담당 Marcus가 광고 설정을 돕게 하세요. 모든 광고는 사람이 승인하고 켭니다.',
  waiting: '도장을 확인하는 중…', noSchool: '광고를 보려면 도장을 선택하세요.', concealed: '자리를 비운 동안 숨겼습니다. 도장이 확인되면 다시 표시됩니다.',
  loading: '광고 연결을 읽는 중…', denied: '이 도장의 광고 연결을 볼 수 없습니다. 도장 소유자에게 권한을 요청하세요.', unavailable: '광고 연결을 불러오지 못했습니다.', refresh: '다시 확인',
  metaTitle: 'Meta 광고', metaHelp: 'Facebook 및 Instagram 광고는 Zernio로 연결된 도장의 Facebook 페이지에서 실행됩니다. 광고비는 도장의 Meta 광고 계정이 Meta에 직접 지불하며, HON은 광고비를 보관하거나 붙여 받지 않습니다.',
  meta_NOT_CONNECTED: '연결되지 않음. 먼저 Facebook 페이지를 연결하세요.', meta_CONNECTED_ADS_OFF: 'Facebook이 연결되었습니다. 모든 페이지의 광고가 꺼져 있습니다. 소셜 계정에서 페이지의 광고를 켜세요.',
  meta_READY_FOR_ADS: 'Facebook이 연결되었고, 하나 이상의 페이지에서 광고가 켜져 있습니다.',
  connectMeta: 'Meta 광고용 Facebook 연결', connecting: '여는 중…', connectHelp: 'Facebook 페이지에서 로그인한 뒤 HON으로 돌아옵니다.',
  connectOff: 'HON OS에서 광고 계정 연결이 아직 켜지지 않았습니다. 아무것도 연결되지 않았습니다.',
  adsOn: '광고 켜짐', adsOff: '광고 꺼짐', changeOnSocial: '소셜 계정에서 변경',
  metaNext: 'Meta 광고 만들기와 실행은 다음 업데이트에서 제공됩니다. 월 광고비 한도를 정하고, 모든 광고는 일시 중지 상태로 시작하며, 사람이 켭니다.',
  googleTitle: 'Google 광고', googleStatus: '아직 사용할 수 없습니다.',
  googleHelp: 'Google 광고는 이후 업데이트에서 같은 보안 연결(Zernio)로 연결되며, 같은 월 한도와 같은 사람 승인을 따릅니다. 오늘은 아무것도 연결되거나 청구되지 않습니다.',
  aiTitle: 'AI로 광고 설정', aiHelp: '지금 Marcus가 광고 문구를 작성할 수 있습니다. 캠페인을 고르고 광고를 설명하면 Marcus가 초안을 씁니다. 모든 초안은 저장 전에 사람이 승인합니다.',
  aiNext: '다음에는 Marcus가 홍보할 게시물, 한도 안의 예산, 날짜도 제안합니다. 검토하고 승인하며, 저절로 실행되는 것은 없습니다.',
  openMarcus: 'Marcus에게 광고 요청', openCampaigns: '캠페인 플래너',
  e_DENIED: '이 도장에서 계정을 연결할 권한이 없습니다. 변경된 것이 없습니다.', e_NOT_ENABLED: 'HON OS에서 연결이 아직 켜지지 않았습니다. 변경된 것이 없습니다.',
  e_LIMIT: '시도가 너무 많습니다. 나중에 다시 하세요. 변경된 것이 없습니다.', e_PROVIDER: 'Zernio가 응답하지 않았습니다. 연결된 것이 없습니다. 다시 시작하세요.',
  e_INVALID: '받아들여지지 않았습니다. 변경된 것이 없습니다.', e_UNKNOWN: '연결이 시작되었는지 확인할 수 없습니다. 다시 시작하세요. 사용하지 않은 링크는 저절로 만료됩니다.',
};
const es: Record<AdsKey, string> = {
  title: 'Anuncios', intro: 'Conecta Meta Ads y Google Ads para tu escuela y deja que Marcus, tu especialista en marketing, te ayude a preparar cada anuncio. Una persona aprueba cada anuncio y lo activa.',
  waiting: 'Comprobando tu escuela…', noSchool: 'Elige una escuela para ver sus anuncios.', concealed: 'Oculto mientras no estabas. Se muestra de nuevo cuando se comprueba tu escuela.',
  loading: 'Leyendo tus conexiones de anuncios…', denied: 'No puedes ver las conexiones de anuncios de esta escuela. Pide acceso al dueño de la escuela.', unavailable: 'No se pudieron cargar tus conexiones de anuncios.', refresh: 'Comprobar de nuevo',
  metaTitle: 'Meta Ads', metaHelp: 'Los anuncios de Facebook e Instagram se publican desde la página de Facebook de tu escuela, conectada a través de Zernio. Tu cuenta publicitaria de Meta paga a Meta directamente; HON nunca guarda ni recarga el dinero de anuncios.',
  meta_NOT_CONNECTED: 'No conectado. Conecta primero tu página de Facebook.', meta_CONNECTED_ADS_OFF: 'Facebook conectado. Los anuncios están desactivados en todas las páginas; actívalos para una página en Cuentas sociales.',
  meta_READY_FOR_ADS: 'Facebook conectado, con anuncios activados en al menos una página.',
  connectMeta: 'Conectar Facebook para Meta Ads', connecting: 'Abriendo…', connectHelp: 'Inicias sesión con Facebook en su propia página y luego vuelves a HON.',
  connectOff: 'La conexión de cuentas publicitarias aún no está activada en HON OS. No se ha conectado nada.',
  adsOn: 'Anuncios activados', adsOff: 'Anuncios desactivados', changeOnSocial: 'Cambiar en Cuentas sociales',
  metaNext: 'Crear y publicar anuncios de Meta llega en la próxima actualización: fijas un límite mensual de gasto, cada anuncio empieza en pausa y una persona lo activa.',
  googleTitle: 'Google Ads', googleStatus: 'Aún no disponible.',
  googleHelp: 'Google Ads se conectará con la misma conexión segura (Zernio) en una actualización posterior, con el mismo límite mensual y la misma aprobación humana. Hoy no se conecta ni se cobra nada.',
  aiTitle: 'Preparar un anuncio con IA', aiHelp: 'Marcus ya puede escribir el texto de tu anuncio: elige una campaña, describe el anuncio y Marcus lo redacta. Una persona aprueba cada borrador antes de guardarlo.',
  aiNext: 'Después, Marcus también sugerirá qué publicación promocionar, el presupuesto dentro de tu límite y las fechas. Tú revisas y apruebas; nada se publica solo.',
  openMarcus: 'Pedir un anuncio a Marcus', openCampaigns: 'Planificador de campañas',
  e_DENIED: 'No tienes permiso para conectar cuentas en esta escuela. No cambió nada.', e_NOT_ENABLED: 'La conexión aún no está activada en HON OS. No cambió nada.',
  e_LIMIT: 'Demasiados intentos. Inténtalo más tarde. No cambió nada.', e_PROVIDER: 'Zernio no respondió. No se conectó nada. Empieza de nuevo.',
  e_INVALID: 'No se aceptó. No cambió nada.', e_UNKNOWN: 'No pudimos confirmar si la conexión empezó. Empieza de nuevo; un enlace sin usar caduca solo.',
};
export const ADS_LANGUAGES = ['en', 'ko', 'es'] as const;
const catalogs: Record<typeof ADS_LANGUAGES[number], Record<AdsKey, string>> = { en, ko, es };
export function adsText(language: string, key: AdsKey): string {
  const catalog = (catalogs as Record<string, Record<AdsKey, string>>)[language] ?? en;
  return catalog[key] ?? en[key];
}
