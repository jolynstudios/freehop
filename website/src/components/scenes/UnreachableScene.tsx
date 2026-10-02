import {C, Cloud, Envelope, HopArc, House, Mailbox, Mover, NameTag, PaperPlane, Wall, arc, line, motion as m, useMotionAllowed} from '../illustrations';
import SceneFrame from './SceneFrame';

/** A gate-only network: a wall with one mail slot. Envelopes pass, planes cannot. */
export default function UnreachableScene({caption}: {caption?: string}) {
  const motion = useMotionAllowed();
  const mail = arc([338, 210], [162, 176], 42);
  const plane = arc([690, 92], [488, 172], 34);
  return (
    <SceneFrame
      title="An office building sits behind a brick wall that has only a mail slot. A sealed envelope slips out through the slot to a mailbox gate, but a paper plane flying in from the right bumps into the wall and falls."
      caption={caption}>
      <Cloud x={600} y={64} scale={0.56} flip className={m.driftLate} />
      <path d="M-10 274 Q360 228 730 274 V310 H-10 Z" fill={C.azure} stroke={C.ink} strokeWidth={5} strokeLinejoin="round" />
      <HopArc arc={mail} pattern="dashes" slow />
      <HopArc arc={plane} />
      <House x={360} y={252} scale={1.08} variant="tall" waves />
      <Wall x={244} y={150} width={232} height={104} slot={[360, 208]} />
      <Mailbox x={146} y={260} scale={0.86} flag="anim" />
      <Mover arc={mail} dur={4.4} travel={0.55} rest={0.55} orient={false} motion={motion}>
        <Envelope scale={0.62} />
      </Mover>
      <Mover arc={plane} dur={3.2} travel={0.6} rest={0.62} motion={motion}>
        <PaperPlane scale={0.9} />
      </Mover>
      <g transform="translate(486 172)" className={m.blinkSoft}>
        <path d="M0 -16 L4 -5 L15 -8 L7 1 L13 11 L1 6 L-6 15 L-5 3 L-16 -1 L-5 -5 Z" fill={C.yellow} {...line} strokeWidth={3} />
      </g>
      <PaperPlane x={520} y={252} rotate={168} scale={0.8} />
      <NameTag x={146} y={283} text="GATE" />
      <NameTag x={360} y={286} text="GATE-ONLY NETWORK" size={14} fill={C.yellow} />
    </SceneFrame>
  );
}
