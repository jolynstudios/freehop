import clsx from 'clsx';
import {C, DISPLAY_FONT, line} from './palette';
import m from './motion.module.css';

type Placed = {x?: number; y?: number; scale?: number; rotate?: number; className?: string};
const place = ({x = 0, y = 0, scale = 1, rotate = 0}: Placed) => `translate(${x} ${y}) rotate(${rotate}) scale(${scale})`;

/** A neighbour: the participant who passes media along when two homes cannot see each other. */
export function Person({shirt = C.azure, cap = C.coral, arms = 'up', animate = true, ...p}: Placed & {shirt?: string; cap?: string; arms?: 'up' | 'wave' | 'down'; animate?: boolean}) {
  return (
    <g transform={place(p)} className={p.className}>
      <path d="M-8 0 V-26 M8 0 V-26" {...line} strokeWidth={6} fill="none" />
      <g className={clsx(animate && arms !== 'down' && m.wiggle)}>
        {arms === 'up' && <path d="M-14 -54 L-31 -84 M14 -54 L31 -84" {...line} strokeWidth={6} fill="none" />}
        {arms === 'wave' && <path d="M-14 -54 L-30 -40 M14 -54 L32 -82" {...line} strokeWidth={6} fill="none" />}
        {arms === 'down' && <path d="M-14 -54 L-24 -30 M14 -54 L24 -30" {...line} strokeWidth={6} fill="none" />}
      </g>
      <rect x={-17} y={-64} width={34} height={42} rx={13} fill={shirt} {...line} />
      <circle cx={0} cy={-81} r={16} fill={C.white} {...line} />
      <path d="M-16 -84 A16 16 0 0 1 16 -84 Z" fill={cap} {...line} strokeWidth={3} />
      <circle cx={-5.5} cy={-77} r={2.2} fill={C.ink} />
      <circle cx={5.5} cy={-77} r={2.2} fill={C.ink} />
      <path d="M-5 -70 Q0 -66 5 -70" fill="none" {...line} strokeWidth={2.5} />
    </g>
  );
}

/** A beach ball: the media a neighbour passes along. Centred on (0,0). */
export function Ball(p: Placed) {
  return (
    <g transform={place(p)} className={p.className}>
      <circle r={12} fill={C.coral} />
      <ellipse rx={5} ry={12} fill={C.white} />
      <circle r={12} fill="none" {...line} strokeWidth={3} />
      <path d="M0 -12 V12" {...line} strokeWidth={2} />
    </g>
  );
}

/** A room key: what members hold and gates never get. Centred on (0,0), pointing right. */
export function Key({fill = C.yellow, ...p}: Placed & {fill?: string}) {
  return (
    <g transform={place(p)} className={p.className}>
      <path d="M-4 -4 H22 V4 H18 V10 H13 V4 H9 V9 H4 V4 H-4 Z" fill={fill} {...line} strokeWidth={3} />
      <circle cx={-12} cy={0} r={11} fill={fill} {...line} strokeWidth={3} />
      <circle cx={-14} cy={0} r={3.5} fill={C.ink} />
    </g>
  );
}

/** A speech bubble with display lettering. (x, y) is the tip of its tail. */
export function Bubble({text, tail = 'down', fill = C.white, color = C.ink, size = 18, ...p}: Placed & {text: string; tail?: 'down' | 'left' | 'right'; fill?: string; color?: string; size?: number}) {
  const w = Math.round(text.length * size * 0.56 + 26);
  const h = Math.round(size * 1.65);
  let bx = -w / 2;
  let by = -h - 13;
  // The tail, and a patch that hides the bubble outline where the tail joins it.
  let tailPath = 'M-8 -15 L0 0 L8 -15';
  let patch = {x: -6.5, y: -17.6, width: 13, height: 4.5};
  if (tail === 'left') {
    bx = 13;
    by = -h / 2;
    tailPath = 'M15 -7 L0 0 L15 7';
    patch = {x: 12, y: -5.5, width: 4.5, height: 11};
  } else if (tail === 'right') {
    bx = -w - 13;
    by = -h / 2;
    tailPath = 'M-15 -7 L0 0 L-15 7';
    patch = {x: -16.5, y: -5.5, width: 4.5, height: 11};
  }
  return (
    <g transform={place(p)} className={p.className}>
      <rect x={bx} y={by} width={w} height={h} rx={h / 2} fill={fill} {...line} strokeWidth={3} />
      <path d={tailPath} fill={fill} {...line} strokeWidth={3} />
      <rect {...patch} fill={fill} />
      <text x={bx + w / 2} y={by + h / 2 + size * 0.36} textAnchor="middle" fontFamily={DISPLAY_FONT} fontSize={size} fill={color} letterSpacing={0.5}>
        {text}
      </text>
    </g>
  );
}

/** A name sign: a pill with a name in display lettering, centred on (x, y). */
export function NameTag({text, fill = C.white, color = C.ink, size = 17, ...p}: Placed & {text: string; fill?: string; color?: string; size?: number}) {
  const w = Math.round(text.length * size * 0.55 + 22);
  const h = Math.round(size * 1.55);
  return (
    <g transform={place(p)} className={p.className}>
      <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={h / 2} fill={fill} {...line} strokeWidth={3} />
      <text x={0} y={size * 0.36} textAnchor="middle" fontFamily={DISPLAY_FONT} fontSize={size} fill={color} letterSpacing={0.5}>
        {text}
      </text>
    </g>
  );
}

/** A classic rented relay (TURN) server with its meter running. Base centre at (0,0). */
export function RelayTower({animate = true, ...p}: Placed & {animate?: boolean}) {
  return (
    <g transform={place(p)} className={p.className}>
      <rect x={-38} y={-124} width={76} height={124} rx={4} fill={C.white} {...line} />
      {[0, 1, 2, 3].map(i => (
        <g key={i}>
          <rect x={-26} y={-110 + i * 27} width={52} height={17} rx={3} fill={C.white} {...line} strokeWidth={3} />
          <circle cx={-16} cy={-101.5 + i * 27} r={3.2} fill={i % 2 ? C.azure : C.coral} className={clsx(animate && i % 2 === 0 && m.blinkSoft)} />
          <path d={`M-6 ${-101.5 + i * 27} H16`} {...line} strokeWidth={3} />
        </g>
      ))}
      <circle cx={0} cy={-150} r={21} fill={C.yellow} {...line} />
      <text x={0} y={-142} textAnchor="middle" fontFamily={DISPLAY_FONT} fontSize={24} fill={C.ink}>
        $
      </text>
      <path d="M0 -129 V-124" {...line} />
    </g>
  );
}

/** A coin. Centred on (0,0). */
export function Coin(p: Placed) {
  return (
    <g transform={place(p)} className={p.className}>
      <circle r={11} fill={C.yellow} {...line} strokeWidth={3} />
      <text x={0} y={5.5} textAnchor="middle" fontFamily={DISPLAY_FONT} fontSize={15} fill={C.ink}>
        $
      </text>
    </g>
  );
}

/** A little tuft of grass or a pebble row along a ground line, for depth. */
export function Tufts({points, ...p}: Placed & {points: readonly (readonly [number, number])[]}) {
  return (
    <g transform={place(p)} className={p.className} fill="none" {...line} strokeWidth={3}>
      {points.map(([x, y], i) => (
        <path key={i} d={`M${x - 7} ${y} q 3 -9 7 -11 M${x} ${y} q 1 -8 5 -12 M${x + 6} ${y} q 1 -6 6 -8`} />
      ))}
    </g>
  );
}
