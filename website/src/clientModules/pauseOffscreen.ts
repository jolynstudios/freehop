// Pauses illustration animations (SMIL and CSS) while an SVG is off screen, so a long page
// with many small scenes only animates what the visitor can see.
import type {ClientModule} from '@docusaurus/types';

let observer: IntersectionObserver | null = null;

function observeAll() {
  if (typeof window === 'undefined' || !('IntersectionObserver' in window)) return;
  observer?.disconnect();
  observer = new IntersectionObserver(
    entries => {
      for (const entry of entries) {
        const svg = entry.target as SVGSVGElement;
        if (entry.isIntersecting) {
          svg.classList.remove('fh-offscreen');
          svg.unpauseAnimations?.();
        } else {
          svg.classList.add('fh-offscreen');
          svg.pauseAnimations?.();
        }
      }
    },
    {rootMargin: '160px 0px'},
  );
  document.querySelectorAll<SVGSVGElement>('main svg, footer svg').forEach(svg => {
    if (svg.querySelector('animateMotion, [class]')) observer!.observe(svg);
  });
}

const pauseOffscreen: ClientModule = {
  onRouteDidUpdate() {
    // Let the new route render (and hydrate its scenes) before observing.
    window.setTimeout(observeAll, 120);
  },
};

export default pauseOffscreen;
