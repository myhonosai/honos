import { CREATIVE_DESIGN_FONTS, type CreativeDesignDocument, type CreativeDesignFont } from '@hon/contracts';

/**
 * E1 (0703) designer fonts. Each is an open-licence font (SIL OFL 1.1 or Apache 2.0, see public/fonts/design/LICENSES.md)
 * shipped by the web app itself as a Latin woff2, so nothing is fetched from an outside font service. The canvas can only
 * draw a web font once it has loaded, so the editor loads the fonts a design uses before it paints or exports, and
 * paints again when they arrive. Letters a font does not have (Korean, for example) fall back to the system stack.
 */
type FontFile = Readonly<{ file: string; weight: string }>;
type DesignFont = Readonly<{ name: string; family: string; fallback: string; files: readonly FontFile[] }>;

const SANS = 'Arial, Helvetica, sans-serif', SERIF = 'Georgia, "Times New Roman", serif', SCRIPT = '"Segoe Script", "Brush Script MT", cursive';
const shipped = (name: string, slug: string, fallback: string, weights: 'variable' | readonly string[]): DesignFont => ({
  name, family: `HON ${name}`, fallback,
  files: weights === 'variable' ? [{ file: `${slug}.woff2`, weight: '400 700' }] : weights.map(w => ({ file: `${slug}-${w}.woff2`, weight: w })),
});
const system = (name: string, stack: string): DesignFont => ({ name, family: '', fallback: stack, files: [] });

export const DESIGN_FONTS: Readonly<Record<CreativeDesignFont, DesignFont>> = {
  SANS: system('Sans', SANS),
  SERIF: system('Serif', SERIF),
  DISPLAY: system('Display', 'Impact, "Arial Black", "Helvetica Neue", sans-serif'),
  ROUNDED: system('Rounded', '"Trebuchet MS", "Segoe UI", Verdana, sans-serif'),
  HANDWRITING: system('Handwriting', '"Comic Sans MS", "Segoe Print", "Bradley Hand", cursive'),
  MONO: system('Typewriter', '"Courier New", Courier, monospace'),
  MONTSERRAT: shipped('Montserrat', 'montserrat', SANS, 'variable'),
  POPPINS: shipped('Poppins', 'poppins', SANS, ['400', '700']),
  OSWALD: shipped('Oswald', 'oswald', '"Arial Narrow", Impact, sans-serif', 'variable'),
  BEBAS: shipped('Bebas Neue', 'bebas', 'Impact, "Arial Narrow", sans-serif', ['400']),
  ANTON: shipped('Anton', 'anton', 'Impact, "Arial Black", sans-serif', ['400']),
  ARCHIVO_BLACK: shipped('Archivo Black', 'archivo-black', '"Arial Black", Impact, sans-serif', ['400']),
  PLAYFAIR: shipped('Playfair Display', 'playfair', SERIF, 'variable'),
  MERRIWEATHER: shipped('Merriweather', 'merriweather', SERIF, 'variable'),
  RALEWAY: shipped('Raleway', 'raleway', SANS, 'variable'),
  NUNITO: shipped('Nunito', 'nunito', '"Trebuchet MS", Verdana, sans-serif', 'variable'),
  ROBOTO_SLAB: shipped('Roboto Slab', 'roboto-slab', '"Rockwell", Georgia, serif', 'variable'),
  MARKER: shipped('Permanent Marker', 'marker', '"Comic Sans MS", cursive', ['400']),
  PACIFICO: shipped('Pacifico', 'pacifico', SCRIPT, ['400']),
  DANCING: shipped('Dancing Script', 'dancing', SCRIPT, 'variable'),
  LOBSTER: shipped('Lobster', 'lobster', SCRIPT, ['400']),
  BANGERS: shipped('Bangers', 'bangers', 'Impact, "Comic Sans MS", sans-serif', ['400']),
};

export const FONT_BASE_URL = '/fonts/design/';

/** The CSS font-family list for a design font: the shipped family first, then system fonts for anything it lacks. */
export function fontStack(font: CreativeDesignFont): string {
  const f = DESIGN_FONTS[font];
  return f.family ? `"${f.family}", ${f.fallback}` : f.fallback;
}

/** Every font a design's text uses, in first-use order. */
export function fontsInDocument(doc: CreativeDesignDocument): CreativeDesignFont[] {
  return [...new Set(doc.pages.flatMap(p => p.elements.flatMap(e => e.kind === 'text' ? [e.font] : [])))];
}

type FontHost = Readonly<{ add: (face: FontFace) => void; create: (family: string, source: string, weight: string) => FontFace }>;
function browserHost(): FontHost | null {
  if (typeof FontFace !== 'function' || typeof document === 'undefined' || !document.fonts) return null;
  return { add: face => { document.fonts.add(face); }, create: (family, source, weight) => new FontFace(family, source, { weight, style: 'normal', display: 'swap' }) };
}

const loading = new Map<CreativeDesignFont, Promise<boolean>>();

/**
 * Loads the given fonts once each (later calls share the first load). Resolves to the fonts that are ready; a font
 * that fails to load is dropped from the cache so a later call retries it, and its text keeps the system fallback.
 */
export async function loadDesignFonts(fonts: Iterable<CreativeDesignFont>, host: FontHost | null = browserHost()): Promise<CreativeDesignFont[]> {
  if (!host) return [];
  const wanted = [...new Set(fonts)].filter(f => (CREATIVE_DESIGN_FONTS as readonly string[]).includes(f) && DESIGN_FONTS[f].files.length > 0);
  const results = await Promise.all(wanted.map(font => {
    let p = loading.get(font);
    if (!p) {
      const f = DESIGN_FONTS[font];
      p = Promise.all(f.files.map(async file => {
        const face = host.create(f.family, `url(${FONT_BASE_URL}${file.file}) format("woff2")`, file.weight);
        await face.load();
        host.add(face);
      })).then(() => true, () => { loading.delete(font); return false; });
      loading.set(font, p);
    }
    return p.then(ok => ok ? font : null);
  }));
  return results.filter((f): f is CreativeDesignFont => f !== null);
}

/** Test seam: forget what has loaded. */
export function resetDesignFontsForTests(): void { loading.clear(); }
