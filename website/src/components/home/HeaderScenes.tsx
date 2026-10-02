import {C, Cloud, Envelope, HopArc, House, Lighthouse, Mailbox, Mover, NameTag, PaperPlane, Person, arc, motion as m, useMotionAllowed} from '../illustrations';

/** Two homes in a call; two public trackers on clouds act as the gates. */
export function CallArt() {
  const motion = useMotionAllowed();
  const media = arc([150, 196], [416, 196], 120);
  const back = arc([416, 214], [150, 214], 70);
  const toGateA = arc([132, 168], [148, 92], 28);
  const toGateB = arc([430, 168], [410, 88], -28);
  return (
    <svg viewBox="0 0 560 340" role="img" aria-label="Two homes labelled you and friend send paper planes straight to each other, while each sends a small envelope to a mailbox gate on a cloud.">
      <Cloud x={150} y={108} scale={0.92} className={m.drift} />
      <Mailbox x={150} y={92} scale={0.5} flag="anim" label="GATE" />
      <Cloud x={412} y={104} scale={0.86} flip className={m.driftLate} />
      <Mailbox x={412} y={88} scale={0.5} flag="anim" label="GATE" />
      <ellipse cx={282} cy={300} rx={262} ry={34} fill={C.azure} stroke={C.ink} strokeWidth={5} />
      <HopArc arc={media} width={5} />
      <HopArc arc={back} width={5} slow />
      <HopArc arc={toGateA} pattern="dashes" slow />
      <HopArc arc={toGateB} pattern="dashes" slow />
      <House x={124} y={278} scale={1.02} waves />
      <House x={440} y={278} scale={1.02} flip door="swing" />
      <Mover arc={media} dur={3.2} rest={0.5} motion={motion}>
        <PaperPlane scale={1.1} fold={C.yellow} />
      </Mover>
      <Mover arc={back} dur={3.6} begin={-1.4} rest={0.4} motion={motion}>
        <PaperPlane scale={0.95} />
      </Mover>
      <Mover arc={toGateA} dur={5} travel={0.4} rest={0.6} orient={false} motion={motion}>
        <Envelope scale={0.5} />
      </Mover>
      <Mover arc={toGateB} dur={5} begin={2.5} travel={0.4} rest={0.6} orient={false} motion={motion}>
        <Envelope scale={0.5} />
      </Mover>
      <NameTag x={124} y={300} text="YOU" />
      <NameTag x={440} y={300} text="FRIEND" />
    </svg>
  );
}

/** The cast of the path ladder, ready to play. */
export function DemosArt() {
  const motion = useMotionAllowed();
  const a = arc([96, 196], [258, 128], 60);
  const b = arc([292, 128], [452, 206], 60);
  return (
    <svg viewBox="0 0 560 340" role="img" aria-label="The cast of the demos: a home, a lighthouse host node, a neighbour and a home with an open door, with paper planes hopping between them.">
      <Cloud x={470} y={74} scale={0.7} flip className={m.driftLate} />
      <Cloud x={94} y={84} scale={0.6} className={m.drift} />
      <ellipse cx={282} cy={300} rx={262} ry={34} fill={C.azure} stroke={C.ink} strokeWidth={5} />
      <HopArc arc={a} width={5} />
      <HopArc arc={b} width={5} />
      <House x={84} y={282} scale={0.92} />
      <Lighthouse x={276} y={270} scale={0.8} />
      <Person x={384} y={270} scale={0.92} arms="wave" />
      <House x={482} y={282} scale={0.92} flip door="swing" waves />
      <Mover arc={a} dur={3.4} travel={0.5} rest={0.5} motion={motion}>
        <PaperPlane fold={C.yellow} />
      </Mover>
      <Mover arc={b} dur={3.4} begin={1.7} travel={0.5} rest={0.5} motion={motion}>
        <PaperPlane fold={C.yellow} />
      </Mover>
    </svg>
  );
}
