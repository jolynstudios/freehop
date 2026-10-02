import clsx from 'clsx';
import {C, line} from './palette';
import m from './motion.module.css';

export type LighthouseProps = {
  x?: number;
  y?: number;
  scale?: number;
  rotate?: number;
  beams?: boolean;
  animate?: boolean;
  className?: string;
};

/**
 * The session's host node: it belongs to the session, joins without media and lends its
 * gateway. Base centre at (0,0), about 190 tall.
 */
export default function Lighthouse({x = 0, y = 0, scale = 1, rotate = 0, beams = true, animate = true, className}: LighthouseProps) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotate}) scale(${scale})`} className={className}>
      {beams && (
        <g className={clsx(animate && m.blinkSoft)}>
          <path d="M0 -150 L-74 -176 L-74 -126 Z" fill={C.white} {...line} strokeWidth={3} />
          <path d="M0 -150 L74 -176 L74 -126 Z" fill={C.white} {...line} strokeWidth={3} />
        </g>
      )}
      <path d="M-30 0 L-19 -128 L19 -128 L30 0 Z" fill={C.white} {...line} />
      <path d="M-26.6 -40 L-24.5 -64 L24.5 -64 L26.6 -40 Z" fill={C.coral} {...line} strokeWidth={3} />
      <path d="M-22.4 -88 L-20.5 -110 L20.5 -110 L22.4 -88 Z" fill={C.coral} {...line} strokeWidth={3} />
      <path d="M-9 0 V-15 A9 9 0 0 1 9 -15 V0" fill={C.azure} {...line} strokeWidth={3} />
      <rect x={-15} y={-165} width={30} height={30} fill={C.yellow} {...line} className={clsx(animate && m.lamp)} />
      <path d="M0 -165 V-135" {...line} strokeWidth={3} />
      <rect x={-28} y={-138} width={56} height={10} rx={2} fill={C.ink} />
      <path d="M-20 -165 A20 20 0 0 1 20 -165 Z" fill={C.coral} {...line} />
      <circle cx={0} cy={-190} r={4.5} fill={C.ink} />
      <line x1={0} y1={-185} x2={0} y2={-190} {...line} strokeWidth={3} />
    </g>
  );
}
