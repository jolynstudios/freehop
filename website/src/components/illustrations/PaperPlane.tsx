import {C, line} from './palette';

export type PaperPlaneProps = {
  x?: number;
  y?: number;
  scale?: number;
  rotate?: number;
  fill?: string;
  fold?: string;
  className?: string;
};

/** Media in flight: a paper plane pointing along +x, centred on (0,0). */
export default function PaperPlane({x = 0, y = 0, scale = 1, rotate = 0, fill = C.white, fold = C.white, className}: PaperPlaneProps) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotate}) scale(${scale})`} className={className}>
      <path d="M24 0 L-7 2 L-13 13 Z" fill={fold} {...line} strokeWidth={3} />
      <path d="M24 0 L-19 -14 L-7 2 Z" fill={fill} {...line} strokeWidth={3} />
    </g>
  );
}
