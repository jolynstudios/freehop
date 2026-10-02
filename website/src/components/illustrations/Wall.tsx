import {C, line} from './palette';

export type WallProps = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Centre of the mail slot, if the wall has one: the only opening on a gate-only network. */
  slot?: readonly [number, number];
  fill?: string;
  course?: number;
  brick?: number;
  className?: string;
};

/** A brick wall. Drawn from its top-left corner. */
export default function Wall({x, y, width, height, slot, fill = C.white, course = 18, brick = 40, className}: WallProps) {
  const rows = Math.floor(height / course);
  const mortar: string[] = [];
  for (let r = 1; r < rows + 1; r++) {
    const yy = y + r * course;
    if (yy < y + height - 2) mortar.push(`M${x} ${yy} H${x + width}`);
  }
  for (let r = 0; r < rows + 1; r++) {
    const top = y + r * course;
    const bottom = Math.min(top + course, y + height);
    if (bottom - top < 4) continue;
    const offset = r % 2 ? brick / 2 : 0;
    for (let bx = x + offset + brick; bx < x + width - 6; bx += brick) {
      mortar.push(`M${bx} ${top} V${bottom}`);
    }
  }
  return (
    <g className={className}>
      <rect x={x} y={y} width={width} height={height} fill={fill} {...line} />
      <path d={mortar.join(' ')} fill="none" {...line} strokeWidth={2.5} />
      <rect x={x} y={y} width={width} height={height} fill="none" {...line} />
      {slot && (
        <g>
          <rect x={slot[0] - 21} y={slot[1] - 8} width={42} height={16} rx={3} fill={C.yellow} {...line} strokeWidth={3} />
          <rect x={slot[0] - 15} y={slot[1] - 3} width={30} height={6} rx={3} fill={C.ink} />
        </g>
      )}
    </g>
  );
}
