import {C, Cloud, HopArc, House, Lighthouse, Mover, NameTag, PaperPlane, arc, motion as m, useMotionAllowed} from '../illustrations';
import SceneFrame from './SceneFrame';

/** The session's own host node, a lighthouse that belongs to the session, carries the hop. */
export default function HostNodeScene({caption}: {caption?: string}) {
  const motion = useMotionAllowed();
  const toHost = arc([142, 192], [346, 112], 52);
  const toBen = arc([374, 112], [578, 192], 52);
  return (
    <SceneFrame
      title="Ana's and Ben's houses cannot reach each other. Between them stands a lighthouse, the session's host node, and paper planes travel from Ana to the lighthouse and on to Ben."
      caption={caption}>
      <Cloud x={112} y={84} scale={0.62} className={m.drift} />
      <Cloud x={622} y={78} scale={0.54} flip className={m.driftLate} />
      <ellipse cx={112} cy={334} rx={150} ry={74} fill={C.azure} stroke={C.ink} strokeWidth={5} />
      <ellipse cx={608} cy={334} rx={150} ry={74} fill={C.azure} stroke={C.ink} strokeWidth={5} />
      <circle cx={360} cy={420} r={182} fill={C.azure} stroke={C.ink} strokeWidth={5} />
      <HopArc arc={toHost} />
      <HopArc arc={toBen} />
      <Lighthouse x={360} y={239} scale={0.84} />
      <House x={112} y={262} scale={0.86} />
      <House x={608} y={262} scale={0.86} flip />
      <Mover arc={toHost} dur={3.6} travel={0.5} rest={0.55} motion={motion}>
        <PaperPlane scale={0.9} />
      </Mover>
      <Mover arc={toBen} dur={3.6} begin={1.8} travel={0.5} rest={0.5} motion={motion}>
        <PaperPlane scale={0.9} />
      </Mover>
      <NameTag x={112} y={283} text="ANA" />
      <NameTag x={360} y={272} text="HOST NODE" size={15} />
      <NameTag x={608} y={283} text="BEN" />
    </SceneFrame>
  );
}
