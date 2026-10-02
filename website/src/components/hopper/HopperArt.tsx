import {useId} from 'react';
import {Bubble, C, HopArc, Mover, NameTag, Person, arc, line, useMotionAllowed} from '../illustrations';
import {HopperFigure} from './Mark';

type Screen = {x: number; y: number; w: number; h: number; fill: string; name: string; shirt: string; cap: string; arms: 'up' | 'wave' | 'down'};

const SCREENS: Screen[] = [
  {x: 18, y: 86, w: 232, h: 160, fill: C.azure, name: 'MILA', shirt: C.yellow, cap: C.coral, arms: 'wave'},
  {x: 318, y: 30, w: 222, h: 154, fill: C.white, name: 'THEO', shirt: C.azure, cap: C.yellow, arms: 'down'},
  {x: 164, y: 286, w: 238, h: 158, fill: C.coral, name: 'ANA', shirt: C.yellow, cap: C.azure, arms: 'up'},
];

// Hops between the three calls: Mila to Theo, Theo to Ana, Ana back to Mila.
const HOPS = [arc([226, 112], [352, 92], 74), arc([458, 178], [380, 300], -54), arc([190, 342], [104, 240], -46)];

/** Three friends in a call, with the hopper hopping from screen to screen. */
export default function HopperArt() {
  const motion = useMotionAllowed();
  const id = useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 560 470" role="img" aria-label="Three video screens with Mila, Theo and Ana, and a small yellow hopper hopping from one screen to the next along a dotted line.">
      <defs>
        {SCREENS.map((sc, i) => (
          <clipPath key={sc.name} id={`${id}-screen-${i}`}>
            <rect x={sc.x} y={sc.y} width={sc.w} height={sc.h} rx={22} />
          </clipPath>
        ))}
      </defs>
      {HOPS.map((hop, i) => (
        <HopArc key={i} arc={hop} width={5} slow={i > 0} />
      ))}
      {SCREENS.map((sc, i) => (
        <g key={sc.name}>
          <rect x={sc.x} y={sc.y} width={sc.w} height={sc.h} rx={22} fill={sc.fill} />
          <g clipPath={`url(#${id}-screen-${i})`}>
            <Person x={sc.x + sc.w / 2} y={sc.y + sc.h + 36} scale={1.62} shirt={sc.shirt} cap={sc.cap} arms={sc.arms} animate={motion} />
          </g>
          <rect x={sc.x} y={sc.y} width={sc.w} height={sc.h} rx={22} fill="none" {...line} strokeWidth={5} />
          <NameTag x={sc.x + 50} y={sc.y + sc.h - 22} text={sc.name} size={15} />
        </g>
      ))}
      <Bubble x={488} y={70} tail="left" text="HI!" size={17} />
      {motion ? (
        HOPS.map((hop, i) => (
          <Mover key={i} arc={hop} dur={4.8} begin={i * 1.6} travel={1 / 3} orient={false} motion>
            <HopperFigure scale={0.95} />
          </Mover>
        ))
      ) : (
        <Mover arc={HOPS[0]} rest={0.5} orient={false} motion={false}>
          <HopperFigure scale={0.95} />
        </Mover>
      )}
    </svg>
  );
}
