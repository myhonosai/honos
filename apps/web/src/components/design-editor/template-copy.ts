/**
 * E2 template words: one set per theme, in each editor language. Every style lays out the same words, so a theme reads
 * the same in all four looks. Headlines may hold one line break; they shrink to fit and never wrap. Schedule rows are
 * day, time and class. People change every word after the design is made; nothing here is sent anywhere.
 */
export const TEMPLATE_THEMES = ['trial', 'openHouse', 'camp', 'promotion', 'schedule', 'tournament', 'referral', 'afterSchool', 'birthday', 'holiday'] as const;
export type TemplateTheme = (typeof TEMPLATE_THEMES)[number];

export type ThemeWords = Readonly<{ name: string; kicker: string; head: string; sub: string; details: string; cta: string }>;
export type ScheduleRow = readonly [day: string, time: string, klass: string];
type LanguageWords = Readonly<{ themes: Readonly<Record<TemplateTheme, ThemeWords>>; schedule: readonly ScheduleRow[]; contact: string; back: string;
  styles: Readonly<Record<'bold' | 'clean' | 'fun' | 'elegant', string>>; all: string }>;

const en: LanguageWords = {
  themes: {
    trial: { name: 'Free trial class', kicker: 'NEW STUDENTS WELCOME', head: 'FREE TRIAL\nCLASS', sub: 'Kids, teens and adults. No experience needed.', details: 'Confidence · Focus · Fitness · Respect', cta: 'Book your first class today' },
    openHouse: { name: 'Open house', kicker: 'YOU ARE INVITED', head: 'OPEN\nHOUSE', sub: 'Saturday, 10 AM to 2 PM', details: 'Free mini classes · Meet the instructors · Family fun', cta: 'Bring the whole family' },
    camp: { name: 'Summer camp', kicker: 'AGES 6 TO 12', head: 'SUMMER\nCAMP', sub: 'Weekly sessions · Half or full day', details: 'Martial arts · Games · Confidence · Friends', cta: 'Spots fill fast. Sign up now!' },
    promotion: { name: 'Belt promotion', kicker: 'CONGRATULATIONS', head: 'BELT\nPROMOTION', sub: 'Celebrating every student who tested this month', details: 'Date · Time · Place', cta: 'Family and friends welcome' },
    schedule: { name: 'Class schedule', kicker: 'TRAIN WITH US', head: 'CLASS\nSCHEDULE', sub: 'Classes for every age and level', details: '', cta: 'Your first class is free' },
    tournament: { name: 'Tournament', kicker: 'COMPETE · LEARN · GROW', head: 'TOURNAMENT\nDAY', sub: 'Forms · Sparring · Board breaking', details: 'Date · Time · Venue', cta: 'Register by Friday' },
    referral: { name: 'Bring a friend', kicker: 'BUDDY WEEK', head: 'BRING A\nFRIEND', sub: 'Your friend trains free all week', details: 'You both get a reward when they join', cta: 'Ask at the front desk' },
    afterSchool: { name: 'After-school program', kicker: 'SCHOOL PICKUP INCLUDED', head: 'AFTER-SCHOOL\nPROGRAM', sub: 'Homework time · Martial arts · Healthy snacks', details: 'Monday to Friday, 3 PM to 6:30 PM', cta: 'Reserve your spot' },
    birthday: { name: 'Birthday party', kicker: 'PARTY TIME', head: 'NINJA\nBIRTHDAY', sub: 'Two hours of games, breaking boards and fun', details: 'We host, you celebrate · Up to 20 kids', cta: 'Book your party date' },
    holiday: { name: 'Holiday special', kicker: 'LIMITED TIME', head: 'HOLIDAY\nSPECIAL', sub: 'Gift a month of classes', details: 'Includes a uniform and the first belt test', cta: 'Offer ends December 31' },
  },
  schedule: [['Mon & Wed', '4:30 PM', 'Little Dragons'], ['Mon & Wed', '5:30 PM', 'Kids'], ['Tue & Thu', '6:30 PM', 'Teens & Adults'], ['Saturday', '10:00 AM', 'Open mat']],
  contact: 'Your school · phone · website', back: 'Thank you for training with us!',
  styles: { bold: 'Bold', clean: 'Clean', fun: 'Fun', elegant: 'Elegant' }, all: 'All',
};

const ko: LanguageWords = {
  themes: {
    trial: { name: '무료 체험 수업', kicker: '신규 수련생 환영', head: '무료 체험\n수업', sub: '어린이, 청소년, 성인. 경험이 없어도 됩니다.', details: '자신감 · 집중력 · 체력 · 예의', cta: '오늘 첫 수업을 예약하세요' },
    openHouse: { name: '오픈 하우스', kicker: '여러분을 초대합니다', head: '오픈\n하우스', sub: '토요일 오전 10시 ~ 오후 2시', details: '무료 미니 수업 · 사범님 만나기 · 가족 행사', cta: '온 가족이 함께 오세요' },
    camp: { name: '여름 캠프', kicker: '6세 ~ 12세', head: '여름\n캠프', sub: '주간 프로그램 · 반일 또는 종일', details: '무술 · 게임 · 자신감 · 친구', cta: '자리가 빨리 찹니다. 지금 신청하세요!' },
    promotion: { name: '띠 승급', kicker: '축하합니다', head: '띠 승급\n심사', sub: '이번 달 심사를 본 모든 수련생을 축하합니다', details: '날짜 · 시간 · 장소', cta: '가족과 친구 모두 환영합니다' },
    schedule: { name: '수업 시간표', kicker: '함께 수련해요', head: '수업\n시간표', sub: '모든 연령과 수준을 위한 수업', details: '', cta: '첫 수업은 무료입니다' },
    tournament: { name: '대회', kicker: '도전 · 배움 · 성장', head: '대회\n안내', sub: '품새 · 겨루기 · 격파', details: '날짜 · 시간 · 장소', cta: '금요일까지 등록하세요' },
    referral: { name: '친구 데려오기', kicker: '친구 초대 주간', head: '친구와\n함께', sub: '친구는 일주일 동안 무료로 수련합니다', details: '친구가 등록하면 두 사람 모두 선물을 받아요', cta: '안내 데스크에 문의하세요' },
    afterSchool: { name: '방과 후 프로그램', kicker: '학교 픽업 포함', head: '방과 후\n프로그램', sub: '숙제 시간 · 무술 · 건강 간식', details: '월~금 오후 3시 ~ 6시 30분', cta: '지금 자리를 예약하세요' },
    birthday: { name: '생일 파티', kicker: '파티 시간', head: '닌자\n생일 파티', sub: '두 시간 동안 게임, 격파, 즐거움', details: '준비는 저희가, 축하는 여러분이 · 최대 20명', cta: '파티 날짜를 예약하세요' },
    holiday: { name: '연말 특별 행사', kicker: '기간 한정', head: '연말\n특별 행사', sub: '한 달 수업을 선물하세요', details: '도복과 첫 승급 심사 포함', cta: '12월 31일까지' },
  },
  schedule: [['월·수', '오후 4:30', '리틀 드래곤'], ['월·수', '오후 5:30', '어린이'], ['화·목', '오후 6:30', '청소년·성인'], ['토요일', '오전 10:00', '자유 수련']],
  contact: '학교 이름 · 전화 · 웹사이트', back: '함께 수련해 주셔서 감사합니다!',
  styles: { bold: '강렬하게', clean: '깔끔하게', fun: '즐겁게', elegant: '우아하게' }, all: '전체',
};

const es: LanguageWords = {
  themes: {
    trial: { name: 'Clase de prueba gratis', kicker: 'BIENVENIDOS NUEVOS ALUMNOS', head: 'CLASE DE\nPRUEBA GRATIS', sub: 'Niños, adolescentes y adultos. No se necesita experiencia.', details: 'Confianza · Enfoque · Condición física · Respeto', cta: 'Reserva tu primera clase hoy' },
    openHouse: { name: 'Puertas abiertas', kicker: 'ESTÁS INVITADO', head: 'PUERTAS\nABIERTAS', sub: 'Sábado, de 10 AM a 2 PM', details: 'Mini clases gratis · Conoce a los instructores · Diversión familiar', cta: 'Trae a toda la familia' },
    camp: { name: 'Campamento de verano', kicker: 'DE 6 A 12 AÑOS', head: 'CAMPAMENTO\nDE VERANO', sub: 'Sesiones semanales · Medio día o día completo', details: 'Artes marciales · Juegos · Confianza · Amigos', cta: 'Los lugares se llenan rápido. ¡Inscríbete!' },
    promotion: { name: 'Promoción de cinturón', kicker: 'FELICIDADES', head: 'PROMOCIÓN\nDE CINTURÓN', sub: 'Celebramos a cada alumno que presentó examen este mes', details: 'Fecha · Hora · Lugar', cta: 'Familia y amigos bienvenidos' },
    schedule: { name: 'Horario de clases', kicker: 'ENTRENA CON NOSOTROS', head: 'HORARIO\nDE CLASES', sub: 'Clases para todas las edades y niveles', details: '', cta: 'Tu primera clase es gratis' },
    tournament: { name: 'Torneo', kicker: 'COMPITE · APRENDE · CRECE', head: 'DÍA DE\nTORNEO', sub: 'Formas · Combate · Rompimiento', details: 'Fecha · Hora · Lugar', cta: 'Inscríbete antes del viernes' },
    referral: { name: 'Trae a un amigo', kicker: 'SEMANA DEL AMIGO', head: 'TRAE A\nUN AMIGO', sub: 'Tu amigo entrena gratis toda la semana', details: 'Ambos reciben un premio cuando se inscriba', cta: 'Pregunta en la recepción' },
    afterSchool: { name: 'Programa después de clases', kicker: 'INCLUYE RECOGIDA EN LA ESCUELA', head: 'DESPUÉS\nDE CLASES', sub: 'Tareas · Artes marciales · Meriendas sanas', details: 'Lunes a viernes, de 3 PM a 6:30 PM', cta: 'Reserva tu lugar' },
    birthday: { name: 'Fiesta de cumpleaños', kicker: 'HORA DE FIESTA', head: 'CUMPLEAÑOS\nNINJA', sub: 'Dos horas de juegos, tablas y diversión', details: 'Nosotros organizamos, tú celebras · Hasta 20 niños', cta: 'Reserva la fecha de tu fiesta' },
    holiday: { name: 'Especial de fiestas', kicker: 'TIEMPO LIMITADO', head: 'ESPECIAL\nDE FIESTAS', sub: 'Regala un mes de clases', details: 'Incluye uniforme y el primer examen de cinturón', cta: 'La oferta termina el 31 de diciembre' },
  },
  schedule: [['Lun y Mié', '4:30 PM', 'Pequeños dragones'], ['Lun y Mié', '5:30 PM', 'Niños'], ['Mar y Jue', '6:30 PM', 'Adolescentes y adultos'], ['Sábado', '10:00 AM', 'Práctica libre']],
  contact: 'Tu escuela · teléfono · sitio web', back: '¡Gracias por entrenar con nosotros!',
  styles: { bold: 'Llamativo', clean: 'Limpio', fun: 'Divertido', elegant: 'Elegante' }, all: 'Todos',
};

const ALL: Readonly<Record<string, LanguageWords>> = { en, ko, es };
export function templateWords(language: string): LanguageWords { return ALL[language.slice(0, 2)] ?? en; }
