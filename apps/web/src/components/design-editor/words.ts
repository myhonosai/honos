'use client';
import { createContext, useContext } from 'react';
import type { DesignKey } from './copy';

/**
 * Which words a place uses in place of the school ones (HQ says "HQ" where a school page says "school"). Labels only;
 * nothing here is authority. The default is the school editor's own words.
 */
export const DesignWords = createContext<Readonly<Partial<Record<DesignKey, DesignKey>>>>({});
export const HQ_DESIGN_WORDS: Readonly<Partial<Record<DesignKey, DesignKey>>> = {
  title: 'hqTitle', intro: 'hqIntro', denied: 'hqDenied', photoLimit: 'hqPhotoLimit', refusedLimit: 'hqRefusedLimit', schoolColor: 'hqColor',
};
export function useDesignWords(): Readonly<Partial<Record<DesignKey, DesignKey>>> { return useContext(DesignWords); }
