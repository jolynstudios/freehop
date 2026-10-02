import clsx from 'clsx';
import type {ReactNode} from 'react';
import {C} from './palette';
import {pointOn, type Arc} from './geometry';
import m from './motion.module.css';

export type HopArcProps = {
  arc: Arc;
  color?: string;
  width?: number;
  /** dots (default), dashes or solid. Dash cycles are 16 units so the march loops cleanly. */
  pattern?: 'dots' | 'dashes' | 'solid';
  animate?: boolean;
  slow?: boolean;
  className?: string;
};

const DASH = {dots: '0.1 15.9', dashes: '10 6', solid: undefined};

/** A hop: the dotted line a media path draws between two machines. */
export default function HopArc({arc, color = C.ink, width = 4.5, pattern = 'dots', animate = true, slow = false, className}: HopArcProps) {
  return (
    <path
      d={arc.d}
      fill="none"
      stroke={color}
      strokeWidth={width}
      strokeLinecap="round"
      strokeDasharray={DASH[pattern]}
      className={clsx(animate && pattern !== 'solid' && (slow ? m.dashSlow : m.dash), className)}
    />
  );
}

export type MoverProps = {
  arc: Arc;
  /** Seconds per trip. */
  dur?: number;
  /** Delay in seconds (negative values start mid-trip). */
  begin?: number;
  /** Where the traveller rests when motion is off (0..1 along the arc). */
  rest?: number;
  /** Fraction of each cycle spent travelling; the rest of the cycle it waits at the end, hidden. */
  travel?: number;
  /** Rotate the traveller along the arc's direction. */
  orient?: boolean;
  motion: boolean;
  children: ReactNode;
};

/**
 * Moves its children along an arc with SMIL animateMotion (works in every current browser).
 * Without motion it rests at a fixed point on the arc, so static renders still tell the story.
 */
export function Mover({arc, dur = 3, begin = 0, rest = 0.5, travel = 1, orient = true, motion, children}: MoverProps) {
  if (!motion) {
    const p = pointOn(arc, rest);
    return <g transform={`translate(${p.x} ${p.y}) rotate(${orient ? p.angle : 0})`}>{children}</g>;
  }
  const t = Math.min(Math.max(travel, 0.05), 1);
  const keyTimes = t < 1 ? `0;${t};1` : '0;1';
  const keyPoints = t < 1 ? '0;1;1' : '0;1';
  // A positive delay would leave the traveller parked at the SVG origin until it starts.
  // Repeating animations only care about phase, so express every delay as a negative offset.
  const phase = (((begin % dur) + dur) % dur) - dur;
  const start = `${phase.toFixed(3)}s`;
  return (
    <g>
      <g>
        {children}
        {t < 1 && (
          <animate
            attributeName="opacity"
            dur={`${dur}s`}
            begin={start}
            repeatCount="indefinite"
            values="1;1;0;0"
            keyTimes={`0;${t};${Math.min(t + 0.001, 1)};1`}
            calcMode="discrete"
          />
        )}
      </g>
      <animateMotion
        dur={`${dur}s`}
        begin={start}
        repeatCount="indefinite"
        path={arc.d}
        rotate={orient ? 'auto' : '0'}
        keyPoints={keyPoints}
        keyTimes={keyTimes}
        calcMode="linear"
      />
    </g>
  );
}
