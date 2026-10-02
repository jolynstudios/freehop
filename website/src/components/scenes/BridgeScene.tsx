import {Ball, C, Cloud, HopArc, House, Mover, NameTag, Person, arc, motion as m, useMotionAllowed} from '../illustrations';
import SceneFrame from './SceneFrame';

/** Ana and Ben cannot see each other over the hill; Cleo, on top, passes the ball along. */
export default function BridgeScene({caption}: {caption?: string}) {
  const motion = useMotionAllowed();
  const toCleo = arc([150, 196], [329, 108], 60);
  const toBen = arc([391, 108], [570, 196], 60);
  return (
    <SceneFrame
      title="A hill separates Ana's and Ben's houses. Cleo stands on top of the hill, catches a ball thrown from Ana's side and passes it on to Ben."
      caption={caption}>
      <Cloud x={106} y={80} scale={0.6} className={m.drift} />
      <Cloud x={628} y={84} scale={0.56} flip className={m.driftLate} />
      <path d="M-10 276 Q120 252 220 270 Q360 120 500 270 Q600 252 730 276 V310 H-10 Z" fill={C.azure} stroke={C.ink} strokeWidth={5} strokeLinejoin="round" />
      <HopArc arc={toCleo} />
      <HopArc arc={toBen} />
      <House x={112} y={264} scale={0.86} />
      <House x={608} y={264} scale={0.86} flip />
      <Person x={360} y={196} scale={1.05} arms="up" />
      <Mover arc={toCleo} dur={4} travel={0.5} rest={0.5} orient={false} motion={motion}>
        <Ball />
      </Mover>
      <Mover arc={toBen} dur={4} begin={2} travel={0.5} rest={0.5} orient={false} motion={motion}>
        <Ball />
      </Mover>
      <NameTag x={112} y={284} text="ANA" />
      <NameTag x={360} y={226} text="CLEO" />
      <NameTag x={608} y={284} text="BEN" />
    </SceneFrame>
  );
}
