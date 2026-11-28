'use client';
import React, { useEffect, useRef, useState } from 'react';
import { CREATIVE_DESIGN_SIZES, type CreativeDesignSizeCode } from '@hon/contracts';
import { loadDesignFonts } from './fonts';
import { paintPage } from './paint';
import { STYLE_FONTS, TEMPLATE_IDS, TEMPLATE_STYLES, TEMPLATE_THEMES, templateDocument, templateParts, type Brand, type TemplateCopy, type TemplateId, type TemplateTheme } from './templates';
import { templateWords } from './template-copy';
import s from './design-editor.module.css';

/**
 * E2 template gallery: real previews of every template at the chosen size, in the person's language and school color,
 * filtered by what it is for. Picking one only chooses it; the design is created by the form's own button.
 */
export type GalleryChoice = TemplateId | '';

/** The templates shown for a filter: all 40, or the four looks of one theme. */
export function galleryItems(filter: TemplateTheme | 'all'): readonly TemplateId[] {
  return filter === 'all' ? TEMPLATE_IDS : TEMPLATE_IDS.filter(id => templateParts(id).theme === filter);
}

export const ALL_STYLE_FONTS = TEMPLATE_STYLES.flatMap(style => STYLE_FONTS[style]);

/** A live picture of a template at this size, with its starter words or the words given (a Marcus option). */
export function Preview({ id, code, language, brand, fontsReady, copy = null }: Readonly<{ id: TemplateId; code: CreativeDesignSizeCode; language: string; brand: Brand; fontsReady: number; copy?: TemplateCopy | null }>) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const size = CREATIVE_DESIGN_SIZES[code];
  const width = 132, k = width / size.width;
  useEffect(() => {
    const canvas = ref.current, ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const ratio = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    canvas.width = Math.round(size.width * k * ratio); canvas.height = Math.round(size.height * k * ratio);
    paintPage(ctx, templateDocument(id, code, language, brand, copy).pages[0]!, size, k * ratio, new Map());
  }, [id, code, language, brand.accent, brand.contactLine, fontsReady, copy]); // eslint-disable-line react-hooks/exhaustive-deps
  return <canvas ref={ref} aria-hidden="true" className={s.galleryCanvas} style={{ width, height: Math.round(size.height * k) }} />;
}

export function TemplateGallery({ code, language, brand, value, onChange, blankLabel }: Readonly<{
  code: CreativeDesignSizeCode; language: string; brand: Brand; value: GalleryChoice | null; onChange: (choice: GalleryChoice) => void; blankLabel: string;
}>) {
  const words = templateWords(language);
  const [filter, setFilter] = useState<TemplateTheme | 'all'>('all');
  const [fontsReady, setFontsReady] = useState(0);
  useEffect(() => {
    let alive = true;
    void loadDesignFonts(ALL_STYLE_FONTS).then(ready => { if (alive && ready.length) setFontsReady(n => n + 1); });
    return () => { alive = false; };
  }, []);
  const items = galleryItems(filter);
  return (
    <div className={s.gallery}>
      <div className={s.galleryFilters} role="group" aria-label={words.all}>
        {(['all', ...TEMPLATE_THEMES] as const).map(theme => (
          <button key={theme} type="button" className={s.chip} aria-pressed={filter === theme} onClick={() => setFilter(theme)}>
            {theme === 'all' ? words.all : words.themes[theme].name}
          </button>
        ))}
      </div>
      <div className={s.galleryGrid} role="listbox" aria-label={words.all}>
        <button type="button" role="option" aria-selected={value === ''} className={s.tile} onClick={() => onChange('')}>
          <span className={s.blankTile} style={{ aspectRatio: `${CREATIVE_DESIGN_SIZES[code].width} / ${CREATIVE_DESIGN_SIZES[code].height}` }} aria-hidden="true">+</span>
          <span className={s.tileLabel}>{blankLabel}</span>
        </button>
        {items.map(id => {
          const { theme, style } = templateParts(id);
          return (
            <button key={id} type="button" role="option" aria-selected={value === id} className={s.tile} onClick={() => onChange(id)}
              data-template={id}>
              <Preview id={id} code={code} language={language} brand={brand} fontsReady={fontsReady} />
              <span className={s.tileLabel}>{words.themes[theme].name} · {words.styles[style]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
