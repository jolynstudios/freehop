import {C, line} from './palette';
import m from './motion.module.css';

export type HouseProps = {
  x?: number;
  y?: number;
  scale?: number;
  /** Degrees around the base point; houses standing on a globe rotate along its normal. */
  rotate?: number;
  roof?: string;
  walls?: string;
  windowFill?: string;
  doorFill?: string;
  /** closed, open (a lit doorway) or swing (opens and closes on a loop). */
  door?: 'closed' | 'open' | 'swing';
  /** The home router on the roof, drawn as a little antenna. */
  antenna?: boolean;
  /** Signal arcs around the antenna. */
  waves?: boolean;
  chimney?: boolean;
  flip?: boolean;
  /** house (pitched roof) or tall (a flat-roofed block of flats). */
  variant?: 'house' | 'tall';
  /** A pennant on the roof, in this colour (team colours in game scenes). */
  flag?: string;
  className?: string;
};

function Waves({cx, cy}: {cx: number; cy: number}) {
  return (
    <g fill="none" {...line} strokeWidth={3}>
      <path className={m.wave1} d={`M${cx + 7} ${cy - 7} A10 10 0 0 1 ${cx + 7} ${cy + 7}`} />
      <path className={m.wave2} d={`M${cx + 12} ${cy - 12} A17 17 0 0 1 ${cx + 12} ${cy + 12}`} />
      <path className={m.wave1} d={`M${cx - 7} ${cy - 7} A10 10 0 0 0 ${cx - 7} ${cy + 7}`} />
      <path className={m.wave2} d={`M${cx - 12} ${cy - 12} A17 17 0 0 0 ${cx - 12} ${cy + 12}`} />
    </g>
  );
}

function Door({door, fill, x, w, h}: {door: 'closed' | 'open' | 'swing'; fill: string; x: number; w: number; h: number}) {
  if (door === 'closed') {
    return (
      <g>
        <rect x={x} y={-h} width={w} height={h} fill={fill} {...line} strokeWidth={3} />
        <circle cx={x + w - 5} cy={-h / 2} r={2.2} fill={C.ink} />
      </g>
    );
  }
  return (
    <g>
      <rect x={x} y={-h} width={w} height={h} fill={C.yellow} {...line} strokeWidth={3} />
      <rect x={x} y={-h} width={w} height={h} fill={fill} {...line} strokeWidth={3} className={door === 'swing' ? m.doorSwing : m.doorOpen} />
    </g>
  );
}

function Tall({walls, roof, windowFill, doorFill, door, antenna, waves}: Required<Pick<HouseProps, 'walls' | 'roof' | 'windowFill' | 'doorFill' | 'door' | 'antenna' | 'waves'>>) {
  return (
    <g>
      {antenna && (
        <g>
          <line x1={18} y1={-134} x2={18} y2={-163} {...line} />
          {waves && <Waves cx={18} cy={-167} />}
          <circle cx={18} cy={-167} r={5} fill={C.yellow} {...line} strokeWidth={3} />
        </g>
      )}
      <rect x={-33} y={-128} width={66} height={128} fill={walls} {...line} />
      <rect x={-38} y={-140} width={76} height={14} rx={2} fill={roof} {...line} />
      {[-112, -82, -52].map(y => (
        <g key={y}>
          <rect x={-23} y={y} width={17} height={17} fill={windowFill} {...line} strokeWidth={3} />
          <rect x={6} y={y} width={17} height={17} fill={windowFill} {...line} strokeWidth={3} />
        </g>
      ))}
      <Door door={door} fill={doorFill} x={-10} w={20} h={30} />
    </g>
  );
}

/**
 * A player's home. Base centre at (0,0), about 96 units wide and 120 tall. The coral roof is
 * the home's NAT router; the antenna on it is the router's radio.
 */
export default function House({
  x = 0,
  y = 0,
  scale = 1,
  rotate = 0,
  roof = C.coral,
  walls = C.white,
  windowFill = C.yellow,
  doorFill = C.azure,
  door = 'closed',
  antenna = true,
  waves = false,
  chimney = true,
  flip = false,
  variant = 'house',
  flag,
  className,
}: HouseProps) {
  const sx = flip ? -scale : scale;
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotate}) scale(${sx} ${scale})`} className={className}>
      {variant === 'tall' ? (
        <Tall walls={walls} roof={roof} windowFill={windowFill} doorFill={doorFill} door={door} antenna={antenna} waves={waves} />
      ) : (
        <g>
          {chimney && <rect x={14} y={-97} width={14} height={32} fill={walls} {...line} />}
          {antenna && (
            <g>
              <line x1={-20} y1={-80} x2={-20} y2={-109} {...line} />
              {waves && <Waves cx={-20} cy={-113} />}
              <circle cx={-20} cy={-113} r={5} fill={C.yellow} {...line} strokeWidth={3} />
            </g>
          )}
          {flag && (
            <g>
              <line x1={0} y1={-99} x2={0} y2={-132} {...line} strokeWidth={3.5} />
              <path d="M0 -132 L24 -124 L0 -116 Z" fill={flag} {...line} strokeWidth={3} />
            </g>
          )}
          <rect x={-38} y={-58} width={76} height={58} fill={walls} {...line} />
          <path d="M-49 -54 L0 -99 L49 -54 Z" fill={roof} {...line} />
          <rect x={-29} y={-46} width={23} height={21} fill={windowFill} {...line} strokeWidth={3} />
          <path d="M-17.5 -46 V-25 M-29 -35.5 H-6" {...line} strokeWidth={3} fill="none" />
          <Door door={door} fill={doorFill} x={5} w={21} h={38} />
        </g>
      )}
    </g>
  );
}
