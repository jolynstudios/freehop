import {C, line} from './palette';

export type CloudProps = {
  x?: number;
  y?: number;
  scale?: number;
  flip?: boolean;
  fill?: string;
  className?: string;
};

/** A flat cartoon cloud with a flat bottom, centred on its base (0,0), about 120 wide. */
export default function Cloud({x = 0, y = 0, scale = 1, flip = false, fill = C.white, className}: CloudProps) {
  return (
    <g className={className}>
      <g transform={`translate(${x} ${y}) scale(${flip ? -scale : scale} ${scale})`}>
        <path
          d="M-56 0 H58 A18 18 0 0 0 52 -33 A26 26 0 0 0 10 -46 A31 31 0 0 0 -45 -27 A15 15 0 0 0 -56 0 Z"
          fill={fill}
          {...line}
        />
        <path d="M-24 -10 A12 12 0 0 1 -8 -16" fill="none" {...line} strokeWidth={3} />
      </g>
    </g>
  );
}
