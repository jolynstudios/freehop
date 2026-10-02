import {Bubble, C, Cloud, HopArc, House, Mover, NameTag, PaperPlane, arc, motion as m, useMotionAllowed} from '../illustrations';
import SceneFrame from './SceneFrame';
import styles from './scenes.module.css';

/** Dani's router opens a port when asked; her own front door becomes the route in. */
export default function GatewayScene({caption}: {caption?: string}) {
  const motion = useMotionAllowed();
  const hop = arc([150, 196], [499, 232], 92);
  return (
    <SceneFrame
      title="Dani's house has an antenna on its roof that asks the router for a port: PCP, then NAT-PMP, then UPnP, which answers OK. Her front door swings open and a paper plane from Ben's house flies in."
      caption={caption}>
      <Cloud x={312} y={70} scale={0.6} className={m.drift} />
      <path d="M-10 272 Q360 222 730 272 V310 H-10 Z" fill={C.azure} stroke={C.ink} strokeWidth={5} strokeLinejoin="round" />
      <HopArc arc={hop} />
      <House x={124} y={262} rotate={-3} scale={0.86} />
      <House x={480} y={253} scale={1.32} door="swing" waves />
      <Mover arc={hop} dur={4} travel={0.82} rest={0.6} motion={motion}>
        <PaperPlane scale={0.95} />
      </Mover>
      <g className={styles.pop1}>
        <Bubble x={548} y={72} tail="left" text="PCP?" size={16} />
      </g>
      <g className={styles.pop2}>
        <Bubble x={548} y={112} tail="left" text="NAT-PMP?" size={16} />
      </g>
      <g className={styles.pop3}>
        <Bubble x={548} y={152} tail="left" text="UPnP: OK" size={16} fill={C.azure} color={C.white} />
      </g>
      <path d="M455 104 Q500 96 532 74 M455 106 Q496 112 532 112 M455 108 Q498 128 532 150" fill="none" stroke={C.ink} strokeWidth={2.5} strokeDasharray="0.1 7" strokeLinecap="round" />
      <NameTag x={124} y={283} text="BEN" />
      <NameTag x={480} y={283} text="DANI" />
    </SceneFrame>
  );
}
