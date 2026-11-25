import type { MediaErrorKind } from './http';

/** Marketing > Media copy (en, ko, es). ko and es are typed against en, so a missing key fails `pnpm check`. */
export type MediaOutcomeKind = 'UPLOADING' | 'WORKING' | 'UPLOADED' | 'VIDEO_UPLOADED' | 'RENAMED' | 'DELETED' | 'DELETED_WAITING' | 'COPIED' | MediaErrorKind;
export interface MediaCopy {
  pageTitle: string; intro: string; checking: string; hidden: string; chooseSchool: string; reading: string;
  denied: string; unavailable: string; refresh: string; tryAgain: string;
  usageTitle: string; stored: (used: string, limit: string) => string; month: (used: string, limit: string) => string;
  upload: string; uploadHint: string; libraryTitle: string; empty: string; unfinished: string;
  size: (bytes: string, width: number, height: number) => string;
  copyLink: string; rename: string; save: string; cancel: string; titleLabel: string; titleProblem: string;
  remove: string; confirmRemove: (title: string) => string; confirm: string; back: string;
  outcomes: Record<MediaOutcomeKind, string>;
  privacyNote: string; permissionsHint: string;
  /** 0654 video. */
  videoPreparing: string; videoFailed: string; videoLength: (bytes: string, length: string, width: number, height: number) => string;
  uploadingVideo: (percent: number) => string; videoBadge: string; videoPrivacy: string;
}

const en: MediaCopy = {
  pageTitle: 'Media',
  intro: 'Pictures and videos for your emails and texts. Upload once and use them in any blast.',
  checking: 'Checking your school…', hidden: 'Hidden while you were away.', chooseSchool: 'Choose a school first.', reading: 'Reading…',
  denied: 'You can’t use the media library at this school. Ask the owner to give your role “See media” or “Manage media” in Roles & permissions.',
  unavailable: 'The media library could not be read right now. Refresh to try again.', refresh: 'Refresh', tryAgain: 'Try again',
  usageTitle: 'Storage', stored: (u, l) => `${u} of ${l} stored`, month: (u, l) => `${u} of ${l} uploaded this month`,
  upload: 'Upload pictures or videos', uploadHint: 'Pictures: JPEG, PNG or GIF up to 25 MB. Videos: MP4, MOV or WebM up to 5 GB.', libraryTitle: 'Your pictures and videos', empty: 'No pictures or videos yet.',
  unfinished: 'This upload didn’t finish. Delete it and upload again.',
  size: (b, w, h) => `${b} · ${w} × ${h}`,
  copyLink: 'Copy link', rename: 'Rename', save: 'Save', cancel: 'Cancel', titleLabel: 'Name', titleProblem: 'Use 1 to 100 characters, with no spaces at the start or end.',
  remove: 'Delete', confirmRemove: (t) => `Delete “${t}”? Emails that already show it will show a broken picture.`, confirm: 'Delete it', back: 'Keep it',
  outcomes: {
    UPLOADING: 'Uploading…', WORKING: 'Saving…', UPLOADED: 'Uploaded.', VIDEO_UPLOADED: 'Uploaded. HON is making a smaller copy for email and phones; it shows here when ready.', RENAMED: 'Renamed.', DELETED: 'Deleted.', DELETED_WAITING: 'Deleted. Its link stopped working; the file is removed shortly.',
    COPIED: 'Link copied.', SESSION: 'Your session ended. Sign in again.', DENIED: 'You can’t do that at this school. Nothing changed.',
    CHANGED: 'Someone changed this picture. Refresh and try again.', GONE: 'That picture is gone.', NOT_PICTURE: 'That file isn’t a JPEG, PNG or GIF picture. Nothing was stored.',
    TOO_LARGE: 'That picture is larger than 25 MB. Nothing was stored.', FULL: 'Your school has used its 5 GB of storage. Delete pictures you no longer need.',
    MONTH: 'Your school has uploaded 10 GB this month. Try again next month.', OFF: 'Picture storage isn’t switched on for HON yet, so nothing was stored.',
    BUSY: 'Other pictures are uploading. Try again in a moment.', INVALID: 'That wasn’t accepted. Nothing changed.',
    UNKNOWN: 'We couldn’t confirm that. Try again: it won’t be stored twice.',
    NOT_VIDEO: 'That file isn’t an MP4, MOV or WebM video. Nothing was kept.', VIDEO_TOO_LARGE: 'That video is larger than 5 GB. Nothing was stored.',
    UPLOAD_MISSING: 'The video didn’t finish uploading. Try again and keep this page open.', UPLOAD_MISMATCH: 'The upload was cut short. Delete it and upload the video again.',
  },
  privacyNote: 'Location and camera details are removed from every picture before it is stored. Anyone with a picture’s link can see it, so only upload pictures you would put in an email.',
  permissionsHint: 'Uploading, renaming and deleting need “Manage media”.',
  videoPreparing: 'Preparing a smaller copy…', videoFailed: 'HON couldn’t prepare this video. Delete it and try another file.',
  videoLength: (b, l, w, h) => `${b} · ${l} · ${w} × ${h}`, uploadingVideo: (p) => `Uploading video… ${p}%. Keep this page open.`, videoBadge: 'Video',
  videoPrivacy: 'Videos are shown only as a smaller copy HON makes, with location and camera details removed. The file you upload is never shared.',
};

const ko: MediaCopy = {
  pageTitle: '미디어',
  intro: '이메일과 문자에 넣을 사진과 동영상입니다. 한 번 올리면 모든 단체 발송에서 쓸 수 있습니다.',
  checking: '학교를 확인하는 중…', hidden: '자리를 비운 동안 숨겼습니다.', chooseSchool: '먼저 학교를 선택하세요.', reading: '읽는 중…',
  denied: '이 학교에서는 미디어 보관함을 쓸 수 없습니다. 원장에게 역할 및 권한에서 “미디어 보기” 또는 “미디어 관리”를 요청하세요.',
  unavailable: '지금은 미디어 보관함을 읽을 수 없습니다. 새로고침해 다시 시도하세요.', refresh: '새로고침', tryAgain: '다시 시도',
  usageTitle: '저장 공간', stored: (u, l) => `${l} 중 ${u} 사용`, month: (u, l) => `이번 달 ${l} 중 ${u} 업로드`,
  upload: '사진 또는 동영상 올리기', uploadHint: '사진: JPEG, PNG, GIF 25MB까지. 동영상: MP4, MOV, WebM 5GB까지.', libraryTitle: '내 사진과 동영상', empty: '아직 사진이나 동영상이 없습니다.',
  unfinished: '업로드가 끝나지 않았습니다. 삭제하고 다시 올리세요.',
  size: (b, w, h) => `${b} · ${w} × ${h}`,
  copyLink: '링크 복사', rename: '이름 바꾸기', save: '저장', cancel: '취소', titleLabel: '이름', titleProblem: '1~100자로, 앞뒤 공백 없이 입력하세요.',
  remove: '삭제', confirmRemove: (t) => `“${t}”을(를) 삭제할까요? 이미 보낸 이메일에서는 사진이 깨져 보입니다.`, confirm: '삭제', back: '유지',
  outcomes: {
    UPLOADING: '올리는 중…', WORKING: '저장하는 중…', UPLOADED: '올렸습니다.', VIDEO_UPLOADED: '올렸습니다. HON이 이메일과 휴대폰용 작은 사본을 만드는 중이며, 준비되면 여기에 보입니다.', RENAMED: '이름을 바꿨습니다.', DELETED: '삭제했습니다.', DELETED_WAITING: '삭제했습니다. 링크는 바로 멈췄고 파일은 곧 지워집니다.',
    COPIED: '링크를 복사했습니다.', SESSION: '세션이 끝났습니다. 다시 로그인하세요.', DENIED: '이 학교에서는 할 수 없습니다. 바뀐 것은 없습니다.',
    CHANGED: '다른 사람이 이 사진을 바꿨습니다. 새로고침 후 다시 시도하세요.', GONE: '그 사진은 없습니다.', NOT_PICTURE: 'JPEG, PNG, GIF 사진이 아닙니다. 저장하지 않았습니다.',
    TOO_LARGE: '25MB보다 큽니다. 저장하지 않았습니다.', FULL: '학교 저장 공간 5GB를 다 썼습니다. 필요 없는 사진을 삭제하세요.',
    MONTH: '이번 달 10GB를 이미 올렸습니다. 다음 달에 다시 시도하세요.', OFF: 'HON의 사진 저장이 아직 켜지지 않아 저장하지 않았습니다.',
    BUSY: '다른 사진을 올리는 중입니다. 잠시 후 다시 시도하세요.', INVALID: '받아들여지지 않았습니다. 바뀐 것은 없습니다.',
    UNKNOWN: '확인하지 못했습니다. 다시 시도하세요. 두 번 저장되지 않습니다.',
    NOT_VIDEO: 'MP4, MOV, WebM 동영상이 아닙니다. 보관하지 않았습니다.', VIDEO_TOO_LARGE: '5GB보다 큰 동영상입니다. 저장하지 않았습니다.',
    UPLOAD_MISSING: '동영상 업로드가 끝나지 않았습니다. 이 페이지를 연 채로 다시 시도하세요.', UPLOAD_MISMATCH: '업로드가 중간에 끊겼습니다. 삭제하고 다시 올리세요.',
  },
  privacyNote: '모든 사진은 저장 전에 위치와 카메라 정보를 지웁니다. 링크가 있으면 누구나 볼 수 있으니 이메일에 넣을 사진만 올리세요.',
  permissionsHint: '올리기, 이름 바꾸기, 삭제에는 “미디어 관리” 권한이 필요합니다.',
  videoPreparing: '작은 사본을 만드는 중…', videoFailed: 'HON이 이 동영상을 준비하지 못했습니다. 삭제하고 다른 파일을 올리세요.',
  videoLength: (b, l, w, h) => `${b} · ${l} · ${w} × ${h}`, uploadingVideo: (p) => `동영상 올리는 중… ${p}%. 이 페이지를 닫지 마세요.`, videoBadge: '동영상',
  videoPrivacy: '동영상은 HON이 만든 작은 사본으로만 보이며, 위치와 카메라 정보는 지워집니다. 올린 원본 파일은 공유되지 않습니다.',
};

const es: MediaCopy = {
  pageTitle: 'Multimedia',
  intro: 'Imágenes y videos para tus correos y textos. Súbelos una vez y úsalos en cualquier envío masivo.',
  checking: 'Revisando tu escuela…', hidden: 'Oculto mientras no estabas.', chooseSchool: 'Primero elige una escuela.', reading: 'Leyendo…',
  denied: 'No puedes usar la biblioteca multimedia en esta escuela. Pide al dueño que dé a tu rol “Ver multimedia” o “Administrar multimedia” en Roles y permisos.',
  unavailable: 'No se pudo leer la biblioteca multimedia. Actualiza para intentarlo de nuevo.', refresh: 'Actualizar', tryAgain: 'Intentar de nuevo',
  usageTitle: 'Almacenamiento', stored: (u, l) => `${u} de ${l} guardados`, month: (u, l) => `${u} de ${l} subidos este mes`,
  upload: 'Subir imágenes o videos', uploadHint: 'Imágenes: JPEG, PNG o GIF hasta 25 MB. Videos: MP4, MOV o WebM hasta 5 GB.', libraryTitle: 'Tus imágenes y videos', empty: 'Aún no hay imágenes ni videos.',
  unfinished: 'Esta subida no terminó. Bórrala y vuelve a subirla.',
  size: (b, w, h) => `${b} · ${w} × ${h}`,
  copyLink: 'Copiar enlace', rename: 'Cambiar nombre', save: 'Guardar', cancel: 'Cancelar', titleLabel: 'Nombre', titleProblem: 'Usa de 1 a 100 caracteres, sin espacios al inicio ni al final.',
  remove: 'Borrar', confirmRemove: (t) => `¿Borrar “${t}”? Los correos que ya la muestran verán una imagen rota.`, confirm: 'Borrarla', back: 'Conservarla',
  outcomes: {
    UPLOADING: 'Subiendo…', WORKING: 'Guardando…', UPLOADED: 'Subida.', VIDEO_UPLOADED: 'Subido. HON está haciendo una copia más ligera para correo y teléfonos; aparecerá aquí cuando esté lista.', RENAMED: 'Nombre cambiado.', DELETED: 'Borrada.', DELETED_WAITING: 'Borrada. Su enlace dejó de funcionar; el archivo se quitará en breve.',
    COPIED: 'Enlace copiado.', SESSION: 'Tu sesión terminó. Inicia sesión de nuevo.', DENIED: 'No puedes hacer eso en esta escuela. No cambió nada.',
    CHANGED: 'Alguien cambió esta imagen. Actualiza e inténtalo de nuevo.', GONE: 'Esa imagen ya no está.', NOT_PICTURE: 'Ese archivo no es una imagen JPEG, PNG o GIF. No se guardó nada.',
    TOO_LARGE: 'Esa imagen pesa más de 25 MB. No se guardó nada.', FULL: 'Tu escuela usó sus 5 GB. Borra imágenes que ya no necesites.',
    MONTH: 'Tu escuela ya subió 10 GB este mes. Inténtalo el próximo mes.', OFF: 'El almacenamiento de imágenes de HON aún no está activado, así que no se guardó nada.',
    BUSY: 'Se están subiendo otras imágenes. Inténtalo en un momento.', INVALID: 'No se aceptó. No cambió nada.',
    UNKNOWN: 'No pudimos confirmarlo. Inténtalo de nuevo: no se guardará dos veces.',
    NOT_VIDEO: 'Ese archivo no es un video MP4, MOV o WebM. No se guardó nada.', VIDEO_TOO_LARGE: 'Ese video pesa más de 5 GB. No se guardó nada.',
    UPLOAD_MISSING: 'El video no terminó de subirse. Inténtalo de nuevo con esta página abierta.', UPLOAD_MISMATCH: 'La subida se cortó. Bórralo y vuelve a subir el video.',
  },
  privacyNote: 'Antes de guardar cada imagen se quitan los datos de ubicación y cámara. Cualquiera con el enlace puede verla, así que sube solo imágenes que pondrías en un correo.',
  permissionsHint: 'Subir, cambiar nombre y borrar requieren “Administrar multimedia”.',
  videoPreparing: 'Preparando una copia más ligera…', videoFailed: 'HON no pudo preparar este video. Bórralo y prueba con otro archivo.',
  videoLength: (b, l, w, h) => `${b} · ${l} · ${w} × ${h}`, uploadingVideo: (p) => `Subiendo video… ${p}%. Mantén esta página abierta.`, videoBadge: 'Video',
  videoPrivacy: 'Los videos solo se muestran como una copia más ligera que hace HON, sin datos de ubicación ni de cámara. El archivo que subes nunca se comparte.',
};

export const MEDIA_COPY = { en, ko, es } as const;
export function mediaCopy(language: string): MediaCopy {
  return language === 'ko' ? ko : language === 'es' ? es : en;
}
