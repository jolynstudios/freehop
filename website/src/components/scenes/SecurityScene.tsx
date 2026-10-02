import {Bubble, C, Cloud, Envelope, House, Key, Mailbox, NameTag, motion as m} from '../illustrations';
import SceneFrame from './SceneFrame';

/** Members hold the room key; the gate holds a sealed envelope and no key. */
export default function SecurityScene({caption}: {caption?: string}) {
  return (
    <SceneFrame
      title="Ana and Ben each have the same key above their houses. Between them a blindfolded mailbox gate holds a large sealed envelope and says it has no key."
      caption={caption}>
      <Cloud x={226} y={64} scale={0.5} className={m.drift} />
      <path d="M-10 274 Q360 226 730 274 V310 H-10 Z" fill={C.azure} stroke={C.ink} strokeWidth={5} strokeLinejoin="round" />
      <circle cx={360} cy={402} r={170} fill={C.azure} stroke={C.ink} strokeWidth={5} />
      <House x={136} y={262} scale={0.84} />
      <House x={584} y={262} scale={0.84} flip />
      <g className={m.bob}>
        <Key x={140} y={98} rotate={-14} scale={1.25} />
      </g>
      <g className={m.bobLate}>
        <Key x={580} y={98} rotate={14} scale={1.25} />
      </g>
      <Mailbox x={360} y={236} scale={0.96} flag="up" />
      <g className={m.bob}>
        <Envelope x={360} y={84} scale={2.1} rotate={-6} />
      </g>
      <Bubble x={398} y={150} tail="left" text="NO KEY" size={15} />
      <NameTag x={140} y={282} text="ANA" />
      <NameTag x={360} y={262} text="AES-256-GCM" size={14} fill={C.yellow} />
      <NameTag x={580} y={282} text="BEN" />
    </SceneFrame>
  );
}
