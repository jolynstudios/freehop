import clsx from 'clsx';
import {C, DISPLAY_FONT, line} from './palette';
import m from './motion.module.css';

export type MailboxProps = {
  x?: number;
  y?: number;
  scale?: number;
  rotate?: number;
  body?: string;
  /** A blindfold over the eyes: the gate passes envelopes it cannot read. */
  blind?: boolean;
  /** up, down, or anim (raised while mail is inside, on a loop). */
  flag?: 'up' | 'down' | 'anim';
  label?: string;
  className?: string;
};

/**
 * A gate: a mailbox on a post. Base of the post at (0,0), about 64 wide and 140 tall.
 * Its slot is the only opening; it never holds the key to the envelopes it passes.
 */
export default function Mailbox({
  x = 0,
  y = 0,
  scale = 1,
  rotate = 0,
  body = C.azure,
  blind = true,
  flag = 'up',
  label = 'GATE',
  className,
}: MailboxProps) {
  const flagStyle =
    flag === 'down'
      ? {transformBox: 'fill-box' as const, transformOrigin: '0% 100%', transform: 'rotate(90deg)'}
      : undefined;
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotate}) scale(${scale})`} className={className}>
      <rect x={-5} y={-66} width={10} height={66} fill={C.ink} />
      <g className={clsx(flag === 'anim' && m.flag)} style={flagStyle}>
        <line x1={37} y1={-72} x2={37} y2={-114} {...line} strokeWidth={3.5} />
        <rect x={37} y={-115} width={17} height={13} fill={C.coral} {...line} strokeWidth={3} />
      </g>
      <path d="M-33 -64 V-104 A33 33 0 0 1 33 -104 V-64 Z" fill={body} {...line} />
      {blind ? (
        <g>
          <rect x={-35} y={-119} width={70} height={14} rx={3} fill={C.ink} />
          <path d="M-35 -112 L-50 -122 L-47 -109 Z M-35 -112 L-49 -101 L-38 -104 Z" fill={C.ink} {...line} strokeWidth={2} />
        </g>
      ) : (
        <g>
          <circle cx={-12} cy={-112} r={6.5} fill={C.white} {...line} strokeWidth={3} />
          <circle cx={12} cy={-112} r={6.5} fill={C.white} {...line} strokeWidth={3} />
          <circle cx={-11} cy={-111} r={2.6} fill={C.ink} />
          <circle cx={13} cy={-111} r={2.6} fill={C.ink} />
        </g>
      )}
      <rect x={-19} y={-97} width={38} height={9} rx={4.5} fill={C.ink} />
      {label && (
        <text
          x={0}
          y={-71}
          textAnchor="middle"
          fontFamily={DISPLAY_FONT}
          fontSize={15}
          letterSpacing={1}
          fill={C.white}>
          {label}
        </text>
      )}
    </g>
  );
}
