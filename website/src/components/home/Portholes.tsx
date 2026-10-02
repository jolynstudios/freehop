import {useId, type ReactNode} from 'react';
import {
  Ball,
  C,
  Envelope,
  HopArc,
  House,
  Lighthouse,
  Mover,
  PaperPlane,
  Person,
  Wall,
  arc,
  line,
  useMotionAllowed,
} from '../illustrations';

/** A round window onto a tiny scene: azure sky, yellow ground, chunky rim. */
function Porthole({label, children}: {label: string; children: ReactNode}) {
  const id = useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 220 220" role="img" aria-label={label}>
      <defs>
        <clipPath id={`${id}-clip`}>
          <circle cx={110} cy={110} r={104} />
        </clipPath>
      </defs>
      <circle cx={110} cy={110} r={104} fill={C.azure} />
      <g clipPath={`url(#${id}-clip)`}>
        <ellipse cx={110} cy={268} rx={170} ry={92} fill={C.yellow} {...line} strokeWidth={5} />
        {children}
      </g>
      <circle cx={110} cy={110} r={104} fill="none" {...line} strokeWidth={6} />
    </svg>
  );
}

export function DirectPorthole() {
  const motion = useMotionAllowed();
  const hop = arc([58, 120], [162, 120], 70);
  return (
    <Porthole label="Two homes with a paper plane flying straight between them.">
      <HopArc arc={hop} color={C.white} width={5} />
      <House x={56} y={182} scale={0.62} />
      <House x={164} y={182} scale={0.62} flip />
      <Mover arc={hop} dur={2.6} rest={0.5} motion={motion}>
        <PaperPlane scale={0.8} fold={C.yellow} />
      </Mover>
    </Porthole>
  );
}

export function GatewayPorthole() {
  const motion = useMotionAllowed();
  const hop = arc([14, 92], [134, 170], 46);
  return (
    <Porthole label="A home with its front door open; a paper plane flies in through the door.">
      <HopArc arc={hop} color={C.white} width={5} />
      <House x={128} y={186} scale={0.92} door="swing" waves />
      <Mover arc={hop} dur={3} travel={0.85} rest={0.55} motion={motion}>
        <PaperPlane scale={0.8} fold={C.yellow} />
      </Mover>
    </Porthole>
  );
}

export function RelayPorthole() {
  const motion = useMotionAllowed();
  const a = arc([34, 128], [104, 84], 26);
  const b = arc([116, 84], [186, 128], 26);
  return (
    <Porthole label="A lighthouse between two homes passes a paper plane from one to the other.">
      <HopArc arc={a} color={C.white} width={5} />
      <HopArc arc={b} color={C.white} width={5} />
      <House x={30} y={182} scale={0.48} />
      <House x={190} y={182} scale={0.48} flip />
      <Lighthouse x={110} y={184} scale={0.56} beams={false} />
      <Mover arc={a} dur={3} travel={0.5} rest={0.5} motion={motion}>
        <PaperPlane scale={0.7} fold={C.yellow} />
      </Mover>
      <Mover arc={b} dur={3} begin={1.5} travel={0.5} rest={0.6} motion={motion}>
        <PaperPlane scale={0.7} fold={C.yellow} />
      </Mover>
    </Porthole>
  );
}

export function BridgedPorthole() {
  const motion = useMotionAllowed();
  const a = arc([36, 130], [88, 92], 22);
  const b = arc([132, 92], [184, 130], 22);
  return (
    <Porthole label="A neighbour standing between two homes passes a ball from one to the other.">
      <HopArc arc={a} color={C.white} width={5} />
      <HopArc arc={b} color={C.white} width={5} />
      <House x={30} y={184} scale={0.48} />
      <House x={190} y={184} scale={0.48} flip />
      <Person x={110} y={178} scale={0.8} arms="up" />
      <Mover arc={a} dur={3} travel={0.5} rest={0.5} orient={false} motion={motion}>
        <Ball scale={0.8} />
      </Mover>
      <Mover arc={b} dur={3} begin={1.5} travel={0.5} rest={0.5} orient={false} motion={motion}>
        <Ball scale={0.8} />
      </Mover>
    </Porthole>
  );
}

export function UnreachablePorthole() {
  return (
    <Porthole label="A building behind a brick wall with only a mail slot; an envelope gets out, a paper plane does not.">
      <House x={110} y={186} scale={0.72} variant="tall" />
      <Wall x={46} y={120} width={128} height={66} slot={[110, 150]} course={16} brick={32} />
      <Envelope x={110} y={102} scale={0.6} rotate={-8} />
      <PaperPlane x={186} y={86} rotate={150} scale={0.7} fold={C.yellow} />
      <g transform="translate(176 106)">
        <circle r={11} fill={C.white} {...line} strokeWidth={3} />
        <path d="M-4.5 -4.5 L4.5 4.5 M4.5 -4.5 L-4.5 4.5" {...line} stroke={C.coral} strokeWidth={3.5} />
      </g>
    </Porthole>
  );
}
