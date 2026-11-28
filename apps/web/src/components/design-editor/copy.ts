import type { CreativeDesignFont, CreativeDesignSizeCode } from '@hon/contracts';
import { DESIGN_FONTS } from './fonts';

const en = {
  hqTitle: 'Designs for HON', hqIntro: 'Make flyers, posters and social graphics to market HON OS. Drag things around, click to change them, and download when you are done. Nothing here costs anything or uses AI.',
  hqDenied: 'Your HQ access does not include marketing, so HQ designs are not shown.', hqPhotoLimit: 'HQ has reached its photo limit.',
  hqRefusedLimit: 'HQ has reached the design limit. Archive one first.', hqColor: 'HON color',
  title: 'Designs', intro: 'Make flyers, posters, postcards and social posts for your school. Drag things around, click to change them, and download when you are done.',
  newTitle: 'New design', newName: 'Name', newSize: 'Size', newCreate: 'Create design', newNameDefault: 'Untitled design',
  listActive: 'Your designs', listArchived: 'Archived', showArchived: 'Show archived', showActive: 'Show current designs',
  none: 'No designs yet. Pick a size above to start one.', noneArchived: 'Nothing is archived.', open: 'Open', archive: 'Archive', restore: 'Restore',
  updated: 'Changed {when}', loading: 'Loading…', unavailable: 'Designs could not be loaded. Try again in a moment.', retry: 'Try again',
  denied: 'You do not have access to designs at this school. An owner can give your role Creative designs.', session: 'Your session ended. Sign in again.',
  noSchool: 'Choose a school first.', back: '← All designs',
  saved: 'Saved', saving: 'Saving…', unsaved: 'Not saved yet', saveUnknown: 'Could not confirm the last save. HON will try again.',
  readOnly: 'You can look at this design but not change it.', conflict: 'This design was changed somewhere else. Reload it to keep working.', reload: 'Reload',
  archivedNote: 'This design is archived. Restore it to change it.',
  addText: 'Text', addRect: 'Box', addEllipse: 'Circle', addLine: 'Line', addPhoto: 'Photo', undo: 'Undo', redo: 'Redo', download: 'Download PNG',
  front: 'Front', backSide: 'Back', page: 'Page', canvasLabel: 'Design canvas. Click an item to select it, drag to move it, use the arrow keys to nudge it.',
  layers: 'Layers', layersNone: 'Nothing on this page yet.', properties: 'Selected item', pageSettings: 'Page', background: 'Background color',
  text: 'Text', font: 'Font', fontSize: 'Size', bold: 'Bold', italic: 'Italic', color: 'Color', align: 'Align', alignLeft: 'Left', alignCenter: 'Center', alignRight: 'Right',
  lineHeight: 'Line spacing', fill: 'Fill', noFill: 'No fill', stroke: 'Outline', noStroke: 'No outline', strokeWidth: 'Outline width', lineWidth: 'Thickness',
  radius: 'Rounded corners', fit: 'Photo fit', fitCover: 'Fill the box', fitContain: 'Show whole photo', x: 'Left', y: 'Top', w: 'Width', h: 'Height',
  rotation: 'Rotate', opacity: 'See-through', locked: 'Locked', duplicate: 'Duplicate', remove: 'Delete', forward: 'Forward', backward: 'Backward', toFront: 'To front', toBack: 'To back',
  kindText: 'Text', kindRect: 'Box', kindEllipse: 'Circle', kindLine: 'Line', kindImage: 'Photo',
  photoUploading: 'Adding photo…', photoFailed: 'That photo could not be added. Use a JPEG, PNG or WebP picture.', photoLimit: 'This school has reached its photo limit.',
  elementLimit: 'A page holds at most 150 items.',
  refusedName: 'Another design already has that name.', refusedLimit: 'This school has reached the design limit. Archive one first.', refusedOther: 'That change was not saved.',
  printNote: 'Print size {size}. Downloads are 300 dpi.', screenNote: 'Screen size {size}.',
  units: 'Sizes are in points (72 per inch).', pixels: 'Sizes are in pixels.',
  addQr: 'QR code', kindQr: 'QR code', qrData: 'Link or text in the code', qrHint: 'Up to 200 plain characters. Test-scan it with a phone before printing.', qrBackground: 'Light square behind the code',
  downloadPdf: 'Download print PDF', pdfNote: 'Print PDF: 300 dpi with 1/8 inch bleed and trim marks.', schoolColor: 'School color', addContact: 'Contact line',
  startFrom: 'Start from', blank: 'Blank page', checkOffers: 'Check dates, prices and offers before you print or post.',
  photosLoading: 'Photos are still loading. Try the download again in a moment.',
  fontsFallback: 'A font could not load, so the download uses a similar standard font. Try again for the exact font.',
};
export type DesignKey = keyof typeof en;

const ko: Record<DesignKey, string> = {
  hqTitle: 'HON 디자인', hqIntro: 'HON OS 홍보용 전단, 포스터, 소셜 그래픽을 만드세요. 끌어서 옮기고, 눌러서 바꾸고, 다 되면 내려받으세요. 비용도 AI도 쓰지 않습니다.',
  hqDenied: 'HQ 권한에 마케팅이 없어 HQ 디자인을 보여 주지 않습니다.', hqPhotoLimit: 'HQ 사진 한도에 도달했습니다.',
  hqRefusedLimit: 'HQ 디자인 한도에 도달했습니다. 먼저 하나를 보관하세요.', hqColor: 'HON 색상',
  title: '디자인', intro: '학교 전단지, 포스터, 엽서, 소셜 게시물을 만드세요. 끌어서 옮기고, 눌러서 바꾸고, 다 되면 내려받으세요.',
  newTitle: '새 디자인', newName: '이름', newSize: '크기', newCreate: '디자인 만들기', newNameDefault: '제목 없는 디자인',
  listActive: '내 디자인', listArchived: '보관됨', showArchived: '보관된 디자인 보기', showActive: '현재 디자인 보기',
  none: '아직 디자인이 없습니다. 위에서 크기를 골라 시작하세요.', noneArchived: '보관된 항목이 없습니다.', open: '열기', archive: '보관', restore: '복원',
  updated: '{when} 변경', loading: '불러오는 중…', unavailable: '디자인을 불러오지 못했습니다. 잠시 후 다시 시도하세요.', retry: '다시 시도',
  denied: '이 학교의 디자인에 접근할 수 없습니다. 원장이 역할에 크리에이티브 디자인 권한을 줄 수 있습니다.', session: '세션이 끝났습니다. 다시 로그인하세요.',
  noSchool: '먼저 학교를 선택하세요.', back: '← 모든 디자인',
  saved: '저장됨', saving: '저장 중…', unsaved: '아직 저장되지 않음', saveUnknown: '마지막 저장을 확인하지 못했습니다. HON이 다시 시도합니다.',
  readOnly: '이 디자인을 볼 수는 있지만 바꿀 수는 없습니다.', conflict: '이 디자인이 다른 곳에서 바뀌었습니다. 다시 불러온 뒤 계속하세요.', reload: '다시 불러오기',
  archivedNote: '보관된 디자인입니다. 바꾸려면 복원하세요.',
  addText: '텍스트', addRect: '상자', addEllipse: '원', addLine: '선', addPhoto: '사진', undo: '실행 취소', redo: '다시 실행', download: 'PNG 내려받기',
  front: '앞면', backSide: '뒷면', page: '페이지', canvasLabel: '디자인 캔버스. 항목을 눌러 선택하고, 끌어서 옮기고, 화살표 키로 조금씩 움직이세요.',
  layers: '레이어', layersNone: '이 페이지에는 아직 아무것도 없습니다.', properties: '선택한 항목', pageSettings: '페이지', background: '배경색',
  text: '텍스트', font: '글꼴', fontSize: '크기', bold: '굵게', italic: '기울임', color: '색상', align: '정렬', alignLeft: '왼쪽', alignCenter: '가운데', alignRight: '오른쪽',
  lineHeight: '줄 간격', fill: '채우기', noFill: '채우기 없음', stroke: '테두리', noStroke: '테두리 없음', strokeWidth: '테두리 두께', lineWidth: '두께',
  radius: '둥근 모서리', fit: '사진 맞춤', fitCover: '상자 채우기', fitContain: '사진 전체 보기', x: '왼쪽', y: '위', w: '너비', h: '높이',
  rotation: '회전', opacity: '투명도', locked: '잠금', duplicate: '복제', remove: '삭제', forward: '앞으로', backward: '뒤로', toFront: '맨 앞으로', toBack: '맨 뒤로',
  kindText: '텍스트', kindRect: '상자', kindEllipse: '원', kindLine: '선', kindImage: '사진',
  photoUploading: '사진 추가 중…', photoFailed: '사진을 추가하지 못했습니다. JPEG, PNG 또는 WebP 사진을 사용하세요.', photoLimit: '이 학교의 사진 한도에 도달했습니다.',
  elementLimit: '한 페이지에는 최대 150개 항목만 넣을 수 있습니다.',
  refusedName: '같은 이름의 디자인이 이미 있습니다.', refusedLimit: '이 학교의 디자인 한도에 도달했습니다. 먼저 하나를 보관하세요.', refusedOther: '변경 내용이 저장되지 않았습니다.',
  printNote: '인쇄 크기 {size}. 300dpi로 내려받습니다.', screenNote: '화면 크기 {size}.',
  units: '크기 단위는 포인트(1인치 = 72)입니다.', pixels: '크기 단위는 픽셀입니다.',
  addQr: 'QR 코드', kindQr: 'QR 코드', qrData: '코드에 넣을 링크나 글', qrHint: '일반 문자 200자까지. 인쇄 전에 휴대폰으로 스캔해 보세요.', qrBackground: '코드 뒤 밝은 사각형',
  downloadPdf: '인쇄용 PDF 내려받기', pdfNote: '인쇄용 PDF: 300dpi, 1/8인치 재단 여백과 재단선 포함.', schoolColor: '학교 색상', addContact: '연락처 줄',
  startFrom: '시작 방법', blank: '빈 페이지', checkOffers: '인쇄하거나 게시하기 전에 날짜, 가격, 혜택을 확인하세요.',
  photosLoading: '사진을 아직 불러오는 중입니다. 잠시 후 다시 내려받으세요.',
  fontsFallback: '글꼴을 불러오지 못해 비슷한 기본 글꼴로 내려받았습니다. 정확한 글꼴은 다시 시도하세요.',
};
const es: Record<DesignKey, string> = {
  hqTitle: 'Diseños para HON', hqIntro: 'Crea volantes, carteles y gráficos sociales para promocionar HON OS. Arrastra, haz clic para cambiar y descarga cuando termines. Aquí nada cuesta ni usa IA.',
  hqDenied: 'Tu acceso a HQ no incluye marketing, así que no se muestran los diseños de HQ.', hqPhotoLimit: 'HQ llegó a su límite de fotos.',
  hqRefusedLimit: 'HQ llegó al límite de diseños. Archiva uno primero.', hqColor: 'Color de HON',
  title: 'Diseños', intro: 'Crea volantes, carteles, postales y publicaciones para tu escuela. Arrastra para mover, haz clic para cambiar y descarga al terminar.',
  newTitle: 'Nuevo diseño', newName: 'Nombre', newSize: 'Tamaño', newCreate: 'Crear diseño', newNameDefault: 'Diseño sin título',
  listActive: 'Tus diseños', listArchived: 'Archivados', showArchived: 'Ver archivados', showActive: 'Ver diseños actuales',
  none: 'Aún no hay diseños. Elige un tamaño arriba para empezar.', noneArchived: 'No hay nada archivado.', open: 'Abrir', archive: 'Archivar', restore: 'Restaurar',
  updated: 'Cambiado {when}', loading: 'Cargando…', unavailable: 'No se pudieron cargar los diseños. Inténtalo de nuevo en un momento.', retry: 'Reintentar',
  denied: 'No tienes acceso a los diseños de esta escuela. Un dueño puede dar a tu rol el permiso de diseños creativos.', session: 'Tu sesión terminó. Inicia sesión de nuevo.',
  noSchool: 'Primero elige una escuela.', back: '← Todos los diseños',
  saved: 'Guardado', saving: 'Guardando…', unsaved: 'Aún sin guardar', saveUnknown: 'No se pudo confirmar el último guardado. HON lo intentará de nuevo.',
  readOnly: 'Puedes ver este diseño pero no cambiarlo.', conflict: 'Este diseño cambió en otro lugar. Vuelve a cargarlo para seguir.', reload: 'Volver a cargar',
  archivedNote: 'Este diseño está archivado. Restáuralo para cambiarlo.',
  addText: 'Texto', addRect: 'Caja', addEllipse: 'Círculo', addLine: 'Línea', addPhoto: 'Foto', undo: 'Deshacer', redo: 'Rehacer', download: 'Descargar PNG',
  front: 'Frente', backSide: 'Reverso', page: 'Página', canvasLabel: 'Lienzo del diseño. Haz clic en un elemento para elegirlo, arrástralo para moverlo y usa las flechas para ajustarlo.',
  layers: 'Capas', layersNone: 'Aún no hay nada en esta página.', properties: 'Elemento elegido', pageSettings: 'Página', background: 'Color de fondo',
  text: 'Texto', font: 'Fuente', fontSize: 'Tamaño', bold: 'Negrita', italic: 'Cursiva', color: 'Color', align: 'Alinear', alignLeft: 'Izquierda', alignCenter: 'Centro', alignRight: 'Derecha',
  lineHeight: 'Interlineado', fill: 'Relleno', noFill: 'Sin relleno', stroke: 'Borde', noStroke: 'Sin borde', strokeWidth: 'Grosor del borde', lineWidth: 'Grosor',
  radius: 'Esquinas redondeadas', fit: 'Ajuste de la foto', fitCover: 'Llenar la caja', fitContain: 'Mostrar la foto completa', x: 'Izquierda', y: 'Arriba', w: 'Ancho', h: 'Alto',
  rotation: 'Girar', opacity: 'Transparencia', locked: 'Bloqueado', duplicate: 'Duplicar', remove: 'Eliminar', forward: 'Adelante', backward: 'Atrás', toFront: 'Al frente', toBack: 'Al fondo',
  kindText: 'Texto', kindRect: 'Caja', kindEllipse: 'Círculo', kindLine: 'Línea', kindImage: 'Foto',
  photoUploading: 'Agregando foto…', photoFailed: 'No se pudo agregar esa foto. Usa una imagen JPEG, PNG o WebP.', photoLimit: 'Esta escuela llegó a su límite de fotos.',
  elementLimit: 'Una página admite como máximo 150 elementos.',
  refusedName: 'Ya hay un diseño con ese nombre.', refusedLimit: 'Esta escuela llegó al límite de diseños. Archiva uno primero.', refusedOther: 'Ese cambio no se guardó.',
  printNote: 'Tamaño de impresión {size}. Las descargas son de 300 ppp.', screenNote: 'Tamaño de pantalla {size}.',
  units: 'Las medidas están en puntos (72 por pulgada).', pixels: 'Las medidas están en píxeles.',
  addQr: 'Código QR', kindQr: 'Código QR', qrData: 'Enlace o texto del código', qrHint: 'Hasta 200 caracteres simples. Escanéalo con un teléfono antes de imprimir.', qrBackground: 'Cuadro claro detrás del código',
  downloadPdf: 'Descargar PDF para imprenta', pdfNote: 'PDF para imprenta: 300 ppp con 1/8 de pulgada de sangrado y marcas de corte.', schoolColor: 'Color de la escuela', addContact: 'Línea de contacto',
  startFrom: 'Empezar con', blank: 'Página en blanco', checkOffers: 'Revisa fechas, precios y ofertas antes de imprimir o publicar.',
  photosLoading: 'Las fotos aún se están cargando. Intenta la descarga de nuevo en un momento.',
  fontsFallback: 'Una fuente no se pudo cargar, así que la descarga usa una fuente estándar parecida. Inténtalo de nuevo para la fuente exacta.',
};
const ALL: Record<string, Record<DesignKey, string>> = { en, ko, es };

export function designText(language: string, key: DesignKey, vars?: Record<string, string>): string {
  const table = ALL[language.slice(0, 2)] ?? en;
  let out = table[key] ?? en[key];
  for (const [k, v] of Object.entries(vars ?? {})) out = out.replaceAll(`{${k}}`, v);
  return out;
}

const SIZE_NAMES: Record<string, Record<CreativeDesignSizeCode, string>> = {
  en: { FLYER_LETTER: 'Flyer, letter', FLYER_HALF: 'Flyer, half page', POSTER_11X17: 'Poster, small', POSTER_18X24: 'Poster, large', POSTCARD_4X6: 'Postcard', POSTCARD_5X7: 'Postcard, large',
    SOCIAL_SQUARE: 'Instagram post', SOCIAL_STORY: 'Story or reel cover', EVENT_COVER: 'Facebook event cover' },
  ko: { FLYER_LETTER: '전단지 (레터)', FLYER_HALF: '전단지 (반 페이지)', POSTER_11X17: '포스터 (소)', POSTER_18X24: '포스터 (대)', POSTCARD_4X6: '엽서', POSTCARD_5X7: '엽서 (대)',
    SOCIAL_SQUARE: '인스타그램 게시물', SOCIAL_STORY: '스토리 또는 릴스 표지', EVENT_COVER: '페이스북 이벤트 표지' },
  es: { FLYER_LETTER: 'Volante, carta', FLYER_HALF: 'Volante, media página', POSTER_11X17: 'Cartel, pequeño', POSTER_18X24: 'Cartel, grande', POSTCARD_4X6: 'Postal', POSTCARD_5X7: 'Postal, grande',
    SOCIAL_SQUARE: 'Publicación de Instagram', SOCIAL_STORY: 'Portada de historia o reel', EVENT_COVER: 'Portada de evento de Facebook' },
};
const SIZE_MEASURE: Record<CreativeDesignSizeCode, string> = {
  FLYER_LETTER: '8.5 × 11 in', FLYER_HALF: '5.5 × 8.5 in', POSTER_11X17: '11 × 17 in', POSTER_18X24: '18 × 24 in', POSTCARD_4X6: '6 × 4 in', POSTCARD_5X7: '7 × 5 in',
  SOCIAL_SQUARE: '1080 × 1080 px', SOCIAL_STORY: '1080 × 1920 px', EVENT_COVER: '1920 × 1005 px',
};
export function sizeName(language: string, code: CreativeDesignSizeCode): string { return (SIZE_NAMES[language.slice(0, 2)] ?? SIZE_NAMES.en!)[code]; }
export function sizeMeasure(code: CreativeDesignSizeCode): string { return SIZE_MEASURE[code]; }
/** Font names are the fonts' own names, the same in every language. */
export const FONT_NAMES: Readonly<Record<CreativeDesignFont, string>> =
  Object.fromEntries(Object.entries(DESIGN_FONTS).map(([k, f]) => [k, f.name])) as Record<CreativeDesignFont, string>;
