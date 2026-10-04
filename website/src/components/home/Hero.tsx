import {useEffect, useRef} from 'react';
import Link from '@docusaurus/Link';
import HeroPlanet from './HeroPlanet';
import styles from './Hero.module.css';

/**
 * First scene of the home page. The planet turns with scroll and leans a little toward the
 * pointer; both stop for visitors who prefer reduced motion.
 */
export default function Hero() {
  const ref = useRef<HTMLElement>(null);

  // The yellow navbar belongs to this scene; once the page scrolls on, it turns white.
  useEffect(() => {
    const root = document.documentElement;
    const update = () => root.classList.toggle('fh-scrolled', window.scrollY > 24);
    update();
    window.addEventListener('scroll', update, {passive: true});
    return () => {
      window.removeEventListener('scroll', update);
      root.classList.remove('fh-scrolled');
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let frame = 0;
    let px = 0;
    let py = 0;
    const paint = () => {
      frame = 0;
      const spin = Math.min(window.scrollY, 1400) * 0.035;
      el.style.setProperty('--fh-spin', spin.toFixed(2));
      el.style.setProperty('--fh-px', px.toFixed(3));
      el.style.setProperty('--fh-py', py.toFixed(3));
    };
    const queue = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const onPointer = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      const box = el.getBoundingClientRect();
      px = ((event.clientX - box.left) / box.width) * 2 - 1;
      py = ((event.clientY - box.top) / box.height) * 2 - 1;
      queue();
    };
    window.addEventListener('scroll', queue, {passive: true});
    el.addEventListener('pointermove', onPointer);
    return () => {
      window.removeEventListener('scroll', queue);
      el.removeEventListener('pointermove', onPointer);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <header ref={ref} className={styles.hero}>
      <div className={styles.inner}>
        <div className={styles.top}>
          <p className={styles.eyebrow}>
            <span className={styles.chip}>Open source SDK</span>
            Voice, video and data for apps and games
          </p>
          <h1 className={styles.title}>
            <span className={styles.line1}>Build</span>
            <span className={styles.line2}>
              with
              <svg className={styles.hopMark} viewBox="0 0 220 120" aria-hidden="true">
                <path d="M6 110 Q 96 -26 206 64" fill="none" stroke="#333" strokeWidth="7" strokeLinecap="round" strokeDasharray="0.1 19.9" className={styles.hopDots} />
                <g transform="translate(206 64) rotate(42)">
                  <path d="M24 0 L-7 2 L-13 13 Z" fill="#ffffff" stroke="#333" strokeWidth="4" strokeLinejoin="round" />
                  <path d="M24 0 L-19 -14 L-7 2 Z" fill="#ffffff" stroke="#333" strokeWidth="4" strokeLinejoin="round" />
                </g>
              </svg>
            </span>
            <span className={styles.line3}>Freehop.</span>
          </h1>
        </div>
        <div className={styles.art}>
          <HeroPlanet />
        </div>
        <div className={styles.bottom}>
          <p className={styles.lede}>
            Add live voice, video and data to the product people already use. Freehop is a JavaScript SDK for browser and desktop apps:
            your backend admits the room, while the call travels between the people in it.
          </p>
          <div className={styles.ctas}>
            <Link className={styles.primary} to="/docs/quickstart">
              Start building <span aria-hidden="true">&gt;</span>
            </Link>
            <Link className={styles.secondary} to="/demo">
              Try a live call <span aria-hidden="true">&gt;</span>
            </Link>
            <Link className={styles.tertiary} href="https://github.com/jolynstudios/freehop">
              GitHub
            </Link>
          </div>
          <p className={styles.facts}>
            <span>Apache-2.0</span>
            <span>Browser + Electron</span>
            <span>Alpha</span>
            <Link to="/docs/results">Home-lab network tests: 40/40 passed</Link>
          </p>
          <p className={styles.snippet}><code>{'const call = await connect(ticket, { media: { audio: true } });'}</code></p>
        </div>
      </div>
    </header>
  );
}
