import {C, Cloud, HopArc, House, Lighthouse, Mover, NameTag, PaperPlane, arc, motion as m, onCircle, useMotionAllowed} from '../illustrations';
import SceneFrame from './SceneFrame';

const P = {cx: 360, cy: 540, r: 330};

/** A match: participants' homes flying team pennants around the match's own host node. */
export default function RedlineScene({caption}: {caption?: string}) {
  const motion = useMotionAllowed();
  const spots = [-35, -17, 17, 35].map((deg, i) => ({deg, at: onCircle(P.cx, P.cy, P.r, deg), team: i < 2 ? C.coral : C.azure}));
  const across = arc([170, 170], [550, 170], 120);
  const toHost = arc([248, 150], [336, 96], 26);
  return (
    <SceneFrame
      title="Four participants' houses with red and blue team pennants stand on a blue globe around a lighthouse, the match's host node. Paper planes fly between the houses."
      caption={caption}>
      <Cloud x={92} y={84} scale={0.58} className={m.drift} />
      <Cloud x={640} y={74} scale={0.52} flip className={m.driftLate} />
      <circle cx={P.cx} cy={P.cy} r={P.r} fill={C.azure} stroke={C.ink} strokeWidth={5} />
      <HopArc arc={across} />
      <HopArc arc={toHost} pattern="dashes" slow />
      {spots.map(({deg, at, team}) => (
        <House key={deg} x={at[0]} y={at[1] + 2} rotate={deg} scale={0.78} flip={deg > 0} flag={team} antenna={false} />
      ))}
      <Lighthouse x={360} y={212} scale={0.72} />
      <Mover arc={across} dur={4.2} rest={0.3} motion={motion}>
        <PaperPlane scale={0.9} />
      </Mover>
      <NameTag x={360} y={244} text="HOST NODE" size={15} />
    </SceneFrame>
  );
}
