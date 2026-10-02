import {Bubble, C, Cloud, Envelope, HopArc, House, Mailbox, Mover, NameTag, arc, motion as m, useMotionAllowed} from '../illustrations';
import SceneFrame from './SceneFrame';
import {onEllipse} from './ground';

const HILL = {cx: 360, cy: 384, rx: 440, ry: 144};

/** The gate is a blindfolded mailbox: sealed envelopes go in and come out, unread. */
export default function GateScene({caption}: {caption?: string}) {
  const motion = useMotionAllowed();
  const ana = onEllipse(HILL.cx, HILL.cy, HILL.rx, HILL.ry, 138);
  const ben = onEllipse(HILL.cx, HILL.cy, HILL.rx, HILL.ry, 582);
  const toGate = arc([168, 214], [360, 146], 58);
  const toBen = arc([360, 146], [552, 214], 58);
  return (
    <SceneFrame
      title="Ana's house sends a sealed envelope to a blindfolded mailbox labelled gate, which passes it on, still sealed, to Ben's house."
      caption={caption}>
      <Cloud x={112} y={96} scale={0.78} className={m.drift} />
      <Cloud x={612} y={74} scale={0.62} flip className={m.driftLate} />
      <ellipse cx={HILL.cx} cy={HILL.cy} rx={HILL.rx} ry={HILL.ry} fill={C.azure} stroke={C.ink} strokeWidth={5} />
      <HopArc arc={toGate} />
      <HopArc arc={toBen} />
      <House x={ana.x} y={ana.y + 2} rotate={ana.angle} scale={0.94} />
      <House x={ben.x} y={ben.y + 2} rotate={ben.angle} scale={0.94} flip />
      <Mailbox x={360} y={242} flag="anim" />
      <Bubble x={398} y={108} text="???" tail="left" size={17} />
      <Mover arc={toGate} dur={4} travel={0.5} rest={0.62} orient={false} motion={motion}>
        <Envelope scale={0.9} />
      </Mover>
      <Mover arc={toBen} dur={4} begin={2} travel={0.5} rest={0.4} orient={false} motion={motion}>
        <Envelope scale={0.9} />
      </Mover>
      <NameTag x={ana.x + 4} y={283} text="ANA" />
      <NameTag x={ben.x - 4} y={283} text="BEN" />
    </SceneFrame>
  );
}
