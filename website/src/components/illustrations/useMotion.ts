import {useEffect, useState} from 'react';

/**
 * True once the page runs in a browser whose user has not asked for reduced motion.
 * Server rendering and the first client render always return false, so animated SVG
 * (SMIL) elements are added only after hydration and never for reduced-motion users.
 */
export function useMotionAllowed(): boolean {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setAllowed(!query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return allowed;
}
