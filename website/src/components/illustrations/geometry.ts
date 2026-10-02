export type Pt = readonly [number, number];

/** A quadratic arc from `a` to `b`, bulging `lift` units to the left of the a→b direction. */
export function arc(a: Pt, b: Pt, lift: number) {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular pointing "up" for a left-to-right arc (negative y in SVG).
  const nx = dy / len;
  const ny = -dx / len;
  const c: Pt = [mx + nx * lift, my + ny * lift];
  return {a, b, c, d: `M${a[0]} ${a[1]} Q${c[0]} ${c[1]} ${b[0]} ${b[1]}`};
}

export type Arc = ReturnType<typeof arc>;

/** Point and tangent angle (degrees) at parameter t on a quadratic arc. */
export function pointOn({a, b, c}: Arc, t: number) {
  const u = 1 - t;
  const x = u * u * a[0] + 2 * u * t * c[0] + t * t * b[0];
  const y = u * u * a[1] + 2 * u * t * c[1] + t * t * b[1];
  const tx = 2 * u * (c[0] - a[0]) + 2 * t * (b[0] - c[0]);
  const ty = 2 * u * (c[1] - a[1]) + 2 * t * (b[1] - c[1]);
  return {x, y, angle: (Math.atan2(ty, tx) * 180) / Math.PI};
}

/** Position on a circle, with 0° at the top and angles growing clockwise. */
export function onCircle(cx: number, cy: number, r: number, deg: number): Pt {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)];
}

/** An SVG arc path along a circle between two angles (clockwise), for textPath. */
export function circlePath(cx: number, cy: number, r: number, fromDeg: number, toDeg: number) {
  const [x1, y1] = onCircle(cx, cy, r, fromDeg);
  const [x2, y2] = onCircle(cx, cy, r, toDeg);
  const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
  return `M${x1} ${y1} A${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}
