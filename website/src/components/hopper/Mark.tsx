import clsx from 'clsx';

// Hopper's mark: a small yellow hopper in mid-hop, trailing Freehop's dotted hop line.
// The same drawing lives in static/img/hopper-logo.svg.

/** The mark's drawing, in a 64-unit box. */
export function MarkShapes({trail = true}: {trail?: boolean}) {
  return (
    <>
      {trail && (
        <path d="M4 58 Q4 47 10.5 41" fill="none" stroke="#007fff" strokeWidth={4.6} strokeLinecap="round" strokeDasharray="0.1 7.2" />
      )}
      <g stroke="#333333" strokeWidth={4} strokeLinejoin="round" strokeLinecap="round">
        <path d="M27 23 C19 18 14.5 9.5 17.5 5.5 C21 2 28.5 10 31.5 20 Z" fill="#ffe600" />
        <path d="M33.5 21 C31.5 11 33.5 3 38.5 3 C43.5 4 41.5 14 38.5 22 Z" fill="#ffe600" />
        <path d="M27 47.5 C22 51 18 53 15 53.5" fill="none" strokeWidth={5} />
        <path d="M33 51 C30 55 27 57.5 24 58.5" fill="none" strokeWidth={5} />
        <circle cx="37.5" cy="35.5" r="16" fill="#ffe600" />
        <circle cx="44" cy="31.5" r="5.4" fill="#ffffff" strokeWidth={3} />
      </g>
      <circle cx="45.4" cy="32.1" r="2.5" fill="#333333" />
      <circle cx="53" cy="38.5" r="2.8" fill="#ef3b2c" />
    </>
  );
}

/** The Hopper mark as an inline image. Decorative unless a label is given. */
export default function HopperMark({size = 40, label, className}: {size?: number; label?: string; className?: string}) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={clsx(className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false">
      <MarkShapes />
    </svg>
  );
}

/** The hopper for illustrations, centred on (0, 0) and facing right. */
export function HopperFigure({scale = 1, trail = false}: {scale?: number; trail?: boolean}) {
  return (
    <g transform={`scale(${scale}) translate(-34 -32)`}>
      <MarkShapes trail={trail} />
    </g>
  );
}
