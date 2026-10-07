import clsx from 'clsx';

// Hopper shares Freehop's connected-path symbol.
// The same drawing lives in static/img/hopper-logo.svg.

/** The mark's drawing, in a 64-unit box. */
export function MarkShapes({trail = true}: {trail?: boolean}) {
  return (
    <g fill="none" stroke="currentColor" strokeWidth={4.5}>
      <ellipse cx="25" cy="32" rx="12" ry="21" transform="rotate(24 25 32)" />
      <ellipse cx="39" cy="32" rx="12" ry="21" transform="rotate(24 39 32)" />
    </g>
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
      focusable="false"
    >
      <MarkShapes />
    </svg>
  );
}

/** The mark centred for an inline SVG composition. */
export function HopperFigure({scale = 1, trail = false}: {scale?: number; trail?: boolean}) {
  return (
    <g transform={`scale(${scale}) translate(-34 -32)`}>
      <MarkShapes trail={trail} />
    </g>
  );
}
