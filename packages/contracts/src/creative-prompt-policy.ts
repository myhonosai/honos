// C4: the deterministic, free prompt check that runs before any creative credit is reserved
// (docs/architecture/CREATIVE_AI_IMAGE_VIDEO_PROVIDERS.md §6). Martial arts schools market to families with children,
// so the bar is high. This is ONE reviewed list (English, Korean, Spanish). It cannot see a picture: human approval of
// every asset (0356) is what enforces the rules; this check only reduces what reaches review.
//
// Matching: the prompt is NFKC-normalised and lower-cased. Latin terms match whole words (with simple plural/verb
// endings); Korean terms match as substrings. Martial arts words (kick, punch, spar, fight, belt, nunchaku, bo staff,
// sword forms) are deliberately NOT listed, nor Korean syllables that sit inside common words (술 in 무술 or 기술,
// 아이 in 아이디어).

export type CreativePromptRefusal = 'CONTACT_OR_LINK' | 'BLOCKED_TERM' | 'REALISTIC_CHILD';
export interface CreativePromptVerdict { allowed: boolean; reason: CreativePromptRefusal | null }

/** Sexual content, nudity, graphic injury, violence against people, hate, drugs, self-harm, real people and brands. */
export const CREATIVE_BLOCKED_TERMS: { readonly latin: readonly string[]; readonly korean: readonly string[] } = {
  latin: [
    // sexual content and nudity (EN / ES)
    'nude', 'naked', 'nsfw', 'porn', 'porno', 'pornographic', 'sexy', 'sexual', 'erotic', 'lingerie', 'topless', 'bikini', 'underwear', 'fetish', 'seductive',
    'desnudo', 'desnuda', 'desnudos', 'desnudas', 'sexual', 'erotico', 'erótico', 'erotica', 'erótica', 'lenceria', 'lencería', 'ropa interior',
    // graphic injury and violence against people
    'blood', 'bloody', 'gore', 'gory', 'corpse', 'dead body', 'decapitated', 'mutilated', 'stabbing', 'stabbed', 'gun', 'guns', 'rifle', 'pistol', 'firearm',
    'shooting a', 'murder', 'killing', 'torture', 'execution', 'beaten up', 'bruised face', 'broken bones',
    'sangre', 'sangriento', 'cadaver', 'cadáver', 'apuñalado', 'pistola', 'rifle', 'arma de fuego', 'asesinato', 'tortura',
    // hate
    'nazi', 'swastika', 'kkk', 'white power', 'racist', 'racista',
    // drugs, alcohol and tobacco, self-harm
    'cocaine', 'heroin', 'meth', 'marijuana', 'cannabis', 'weed', 'drugs', 'beer', 'alcohol', 'vodka', 'whiskey', 'cigarette', 'vape', 'vaping',
    'suicide', 'self harm', 'self-harm', 'cutting herself', 'cutting himself',
    'cocaina', 'cocaína', 'heroina', 'heroína', 'droga', 'drogas', 'cerveza', 'cigarrillo', 'suicidio', 'autolesion', 'autolesión',
    // real people and brands (generated people are fictional; logos and marks are never generated)
    'celebrity', 'famous person', 'lookalike', 'look-alike', 'deepfake', 'president', 'politician', 'celebridad', 'famoso', 'famosa', 'presidente',
    'logo of', 'trademark', 'nike', 'adidas', 'ufc', 'disney', 'marvel', 'pokemon', 'pokémon', 'nintendo', 'coca-cola', 'mcdonalds', "mcdonald's",
    'bruce lee', 'jackie chan', 'chuck norris', 'conor mcgregor', 'ronda rousey',
  ],
  korean: [
    '누드', '나체', '알몸', '야한', '성인물', '포르노', '섹시', '속옷', '란제리', '선정적',
    '피투성이', '유혈', '시체', '살인', '고문', '총기', '권총', '소총', '칼에 찔',
    '나치', '인종차별',
    '마약', '대마초', '코카인', '필로폰', '음주', '소주', '맥주', '담배', '전자담배', '자살', '자해',
    '연예인', '유명인', '대통령', '정치인', '딥페이크', '상표', '나이키', '아디다스', '디즈니', '마블', '포켓몬', '이소룡', '성룡',
  ],
};
/** A child in a photorealistic prompt: children may appear only in illustrated or chibi styles (§6). */
export const CREATIVE_CHILD_TERMS = {
  latin: ['child', 'children', 'kid', 'kids', 'toddler', 'toddlers', 'boy', 'boys', 'girl', 'girls', 'baby', 'babies', 'minor', 'minors', 'teen', 'teens', 'teenager', 'teenagers',
    'niño', 'niña', 'niños', 'niñas', 'nino', 'nina', 'ninos', 'ninas', 'bebé', 'bebe', 'adolescente', 'adolescentes'],
  korean: ['아이들', '어린이', '아동', '유아', '소년', '소녀', '아기', '청소년', '미성년'],
} as const;
export const CREATIVE_REALISM_TERMS = {
  latin: ['photo', 'photos', 'photograph', 'photography', 'photographic', 'photorealistic', 'photo-realistic', 'realistic', 'real life', 'real-life', 'lifelike', 'hyperrealistic',
    'dslr', 'portrait photo', 'foto', 'fotos', 'fotografía', 'fotografia', 'realista', 'fotorrealista'],
  korean: ['사진', '실사', '사실적', '포토', '리얼'],
} as const;

const URL = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|co|kr|es|mx|app|ly)\b)/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
// Seven or more digits, allowing spaces, dots, dashes and parentheses between them.
const PHONE = /(?:\d[\s().-]*){7,}/;
const escape = (term: string) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const latinPattern = (terms: readonly string[]) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.map(escape).sort((a, b) => b.length - a.length).join('|')})(?:s|es|ed|ing)?(?![\\p{L}\\p{N}])`, 'u');
const BLOCKED_LATIN = latinPattern(CREATIVE_BLOCKED_TERMS.latin);
const CHILD_LATIN = latinPattern(CREATIVE_CHILD_TERMS.latin);
const REALISM_LATIN = latinPattern(CREATIVE_REALISM_TERMS.latin);
const anyKorean = (text: string, terms: readonly string[]) => terms.some(term => text.includes(term));

/**
 * The prompt check. `text` is every free-text field sent to a provider (prompt, avatar description, video script);
 * `realisticStyle` is set when the chosen look is photorealistic (an avatar in the REALISTIC style).
 */
export function checkCreativePrompt(text: string, options: { realisticStyle?: boolean } = {}): CreativePromptVerdict {
  const t = text.normalize('NFKC').toLowerCase();
  if (URL.test(t) || EMAIL.test(t) || PHONE.test(t)) return { allowed: false, reason: 'CONTACT_OR_LINK' };
  if (BLOCKED_LATIN.test(t) || anyKorean(t, CREATIVE_BLOCKED_TERMS.korean)) return { allowed: false, reason: 'BLOCKED_TERM' };
  const child = CHILD_LATIN.test(t) || anyKorean(t, CREATIVE_CHILD_TERMS.korean);
  const realism = options.realisticStyle === true || REALISM_LATIN.test(t) || anyKorean(t, CREATIVE_REALISM_TERMS.korean);
  if (child && realism) return { allowed: false, reason: 'REALISTIC_CHILD' };
  return { allowed: true, reason: null };
}
