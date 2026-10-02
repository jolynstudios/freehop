import {Cloud, Envelope, Globe, HopArc, House, Mailbox, Mover, PaperPlane, arc, motion as m, onCircle, useMotionAllowed} from '../illustrations';
import SceneFrame from './SceneFrame';

const P = {cx: 360, cy: 486, r: 300};

/** A little planet of homes: media hops house to house, envelopes go to the gate. */
export default function IntroScene({caption}: {caption?: string}) {
  const motion = useMotionAllowed();
  const homes = [-44, -22, 22, 44].map(deg => ({deg, at: onCircle(P.cx, P.cy, P.r, deg)}));
  const gate = onCircle(P.cx, P.cy, P.r, 0);
  // Media: one long hop over the gate and one short hop between neighbours.
  const over = arc([232, 150], [488, 150], 206);
  const short = arc([468, 160], [574, 214], 48);
  // Signalling: one small envelope into the gate's slot.
  const mail = arc([126, 196], [342, 106], 64);
  return (
    <SceneFrame
      title="Houses stand on a blue globe. Paper planes hop directly between houses, while a small sealed envelope goes to a mailbox gate on top of the globe."
      caption={caption}>
      <Cloud x={600} y={80} scale={0.62} flip className={m.driftLate} />
      <Cloud x={120} y={74} scale={0.56} className={m.drift} />
      <Globe cx={P.cx} cy={P.cy} r={P.r} ring />
      <HopArc arc={over} />
      <HopArc arc={short} />
      <HopArc arc={mail} pattern="dashes" slow />
      {homes.map(({deg, at}, i) => (
        <House key={deg} x={at[0]} y={at[1] + 2} rotate={deg} scale={0.82} flip={deg > 0} waves={i === 0} door={i === 3 ? 'swing' : 'closed'} />
      ))}
      <Mailbox x={gate[0]} y={gate[1] + 2} scale={0.78} flag="anim" />
      <Mover arc={over} dur={3.8} rest={0.42} motion={motion}>
        <PaperPlane scale={0.95} />
      </Mover>
      <Mover arc={short} dur={2.6} begin={-1} rest={0.5} motion={motion}>
        <PaperPlane scale={0.8} />
      </Mover>
      <Mover arc={mail} dur={5} travel={0.45} rest={0.55} orient={false} motion={motion}>
        <Envelope scale={0.62} />
      </Mover>
    </SceneFrame>
  );
}
