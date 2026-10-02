import {C, Cloud, Coin, Envelope, HopArc, House, Mailbox, Mover, NameTag, PaperPlane, RelayTower, arc, motion as m, useMotionAllowed} from '../illustrations';
import SceneFrame from './SceneFrame';

/** Left: a rented relay in the middle of the call, meter running. Right: a gate beside a direct call. */
export default function CostScene({caption}: {caption?: string}) {
  const motion = useMotionAllowed();
  const intoTower = arc([92, 178], [176, 126], 34);
  const outOfTower = arc([194, 126], [282, 178], 34);
  const coinA = arc([176, 92], [128, 46], 20);
  const coinB = arc([194, 92], [244, 50], -20);
  const direct = arc([458, 176], [652, 176], 128);
  const toGate = arc([470, 214], [538, 196], 24);
  return (
    <SceneFrame
      title="On the left, media flows from a house through a rented relay server whose coin meter keeps running. On the right, media flies straight from house to house while a small mailbox gate receives a single sealed envelope."
      caption={caption}>
      <Cloud x={322} y={64} scale={0.56} className={m.drift} />
      <path d="M-10 270 Q180 226 360 262 Q540 226 730 270 V310 H-10 Z" fill={C.azure} stroke={C.ink} strokeWidth={5} strokeLinejoin="round" />
      <HopArc arc={intoTower} />
      <HopArc arc={outOfTower} />
      <HopArc arc={direct} />
      <HopArc arc={toGate} pattern="dashes" slow />
      <House x={84} y={261} scale={0.74} />
      <House x={290} y={261} scale={0.74} flip />
      <RelayTower x={185} y={250} scale={0.82} />
      <House x={452} y={256} scale={0.74} />
      <House x={660} y={258} scale={0.74} flip />
      <Mailbox x={556} y={248} scale={0.66} flag="anim" />
      <Mover arc={intoTower} dur={3} travel={0.5} rest={0.5} motion={motion}>
        <PaperPlane scale={0.75} />
      </Mover>
      <Mover arc={outOfTower} dur={3} begin={1.5} travel={0.5} rest={0.55} motion={motion}>
        <PaperPlane scale={0.75} />
      </Mover>
      <Mover arc={coinA} dur={2.4} travel={0.7} rest={0.7} orient={false} motion={motion}>
        <Coin scale={0.95} />
      </Mover>
      <Mover arc={coinB} dur={2.4} begin={1.2} travel={0.7} rest={0.85} orient={false} motion={motion}>
        <Coin scale={0.95} />
      </Mover>
      <Mover arc={direct} dur={3.2} rest={0.45} motion={motion}>
        <PaperPlane scale={0.85} />
      </Mover>
      <Mover arc={toGate} dur={5} travel={0.3} rest={0.6} orient={false} motion={motion}>
        <Envelope scale={0.5} />
      </Mover>
      <NameTag x={185} y={283} text="RENTED RELAY" size={15} />
      <NameTag x={556} y={283} text="YOUR GATE" size={15} />
    </SceneFrame>
  );
}
