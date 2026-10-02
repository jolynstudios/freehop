import {C, Cloud, DISPLAY_FONT, HopArc, House, Mover, NameTag, PaperPlane, arc, line, motion as m, useMotionAllowed} from '../illustrations';
import SceneFrame from './SceneFrame';

const SIGNS = [
  {n: 1, text: 'DIRECT', dir: 1},
  {n: 2, text: 'GATEWAY', dir: -1},
  {n: 3, text: 'RELAY', dir: 1},
  {n: 4, text: 'BRIDGED', dir: -1},
] as const;

function Sign({n, text, dir, y}: {n: number; text: string; dir: 1 | -1; y: number}) {
  const w = 138;
  const h = 31;
  const x0 = dir === 1 ? 368 : 352;
  const tip = dir * 17;
  const d =
    dir === 1
      ? `M${x0} ${y} H${x0 + w} l${tip} ${h / 2} l${-tip} ${h / 2} H${x0} Z`
      : `M${x0} ${y} H${x0 - w} l${tip} ${h / 2} l${-tip} ${h / 2} H${x0} Z`;
  const badgeX = dir === 1 ? x0 + 18 : x0 - 18;
  const textX = dir === 1 ? x0 + 36 : x0 - w + 12;
  return (
    <g>
      <path d={d} fill={C.white} {...line} strokeWidth={3.5} />
      <circle cx={badgeX} cy={y + h / 2} r={10.5} fill={C.yellow} {...line} strokeWidth={3} />
      <text x={badgeX} y={y + h / 2 + 5.5} textAnchor="middle" fontFamily={DISPLAY_FONT} fontSize={15} fill={C.ink}>
        {n}
      </text>
      <text x={textX} y={y + h / 2 + 6.5} fontFamily={DISPLAY_FONT} fontSize={18} fill={C.ink} letterSpacing={0.8}>
        {text}
      </text>
    </g>
  );
}

/** A signpost of routes, tried in order; the plane takes the first road that works. */
export default function PathsScene({caption}: {caption?: string}) {
  const motion = useMotionAllowed();
  const hop = arc([140, 196], [580, 196], 330);
  return (
    <SceneFrame title="A signpost between Ana's and Ben's houses lists four numbered routes: direct, gateway, relay and bridged. A paper plane flies from Ana to Ben." caption={caption}>
      <Cloud x={118} y={86} scale={0.66} className={m.drift} />
      <Cloud x={618} y={92} scale={0.58} flip className={m.driftLate} />
      <path d="M-10 272 Q360 214 730 272 V310 H-10 Z" fill={C.azure} stroke={C.ink} strokeWidth={5} strokeLinejoin="round" />
      <HopArc arc={hop} />
      <rect x={353} y={64} width={14} height={186} fill={C.ink} />
      <circle cx={360} cy={60} r={9} fill={C.coral} {...line} strokeWidth={3} />
      {SIGNS.map((s, i) => (
        <Sign key={s.n} n={s.n} text={s.text} dir={s.dir} y={76 + i * 40} />
      ))}
      <House x={104} y={262} rotate={-4} scale={0.9} />
      <House x={616} y={262} rotate={4} scale={0.9} flip door="swing" />
      <Mover arc={hop} dur={4.6} rest={0.18} motion={motion}>
        <PaperPlane />
      </Mover>
      <NameTag x={104} y={283} text="ANA" />
      <NameTag x={616} y={283} text="BEN" />
    </SceneFrame>
  );
}
