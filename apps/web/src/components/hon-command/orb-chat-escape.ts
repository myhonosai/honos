'use client';

import { useEffect, useRef, type RefObject } from 'react';

/**
 * Escape folds an in-place orb chat back into its card when the focus is inside the chat, or nowhere (a sent question
 * briefly disables the box and the browser drops focus to the page). Escape meant for something else (a dialog, a menu,
 * a field that handled it) is left alone.
 */
export function useOrbChatEscape(panel: RefObject<HTMLElement | null>, onClose: () => void): void {
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const active = document.activeElement;
      if (active && active !== document.body && !panel.current?.contains(active)) return;
      event.preventDefault(); close.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [panel]);
}
