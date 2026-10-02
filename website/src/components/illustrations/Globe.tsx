import {C, line} from './palette';

export type GlobeProps = {
  cx: number;
  cy: number;
  r: number;
  fill?: string;
  /** A dotted inner orbit, white on azure. */
  ring?: boolean;
  className?: string;
};

/** The internet: a flat azure globe with a chunky outline. */
export default function Globe({cx, cy, r, fill = C.azure, ring = false, className}: GlobeProps) {
  return (
    <g className={className}>
      <circle cx={cx} cy={cy} r={r} fill={fill} {...line} strokeWidth={5} />
      {ring && (
        <circle
          cx={cx}
          cy={cy}
          r={r - 24}
          fill="none"
          stroke={C.white}
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray="0.1 15.9"
        />
      )}
    </g>
  );
}
