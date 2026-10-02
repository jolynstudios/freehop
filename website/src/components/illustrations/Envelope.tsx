import {C, line} from './palette';

export type EnvelopeProps = {
  x?: number;
  y?: number;
  scale?: number;
  rotate?: number;
  /** The coral wax seal: AES-256-GCM, the gate cannot open it. */
  sealed?: boolean;
  fill?: string;
  className?: string;
};

/** A sealed signalling envelope, centred on (0,0), 40 by 28. */
export default function Envelope({x = 0, y = 0, scale = 1, rotate = 0, sealed = true, fill = C.white, className}: EnvelopeProps) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotate}) scale(${scale})`} className={className}>
      <rect x={-20} y={-14} width={40} height={28} rx={2} fill={fill} {...line} strokeWidth={3} />
      <path d="M-20 -14 L0 3 L20 -14" fill="none" {...line} strokeWidth={3} />
      {sealed && <circle cx={0} cy={3} r={5.5} fill={C.coral} {...line} strokeWidth={2.5} />}
    </g>
  );
}
