/** Height and tangent angle (degrees) of the top edge of an ellipse at x. */
export function onEllipse(cx: number, cy: number, rx: number, ry: number, x: number) {
  const u = Math.max(-0.999, Math.min(0.999, (x - cx) / rx));
  const root = Math.sqrt(1 - u * u);
  const y = cy - ry * root;
  const slope = (ry * u) / (rx * root);
  return {x, y, angle: (Math.atan(slope) * 180) / Math.PI};
}
