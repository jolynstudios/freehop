import {useId} from 'react';
import {
  C,
  Cloud,
  DISPLAY_FONT,
  Envelope,
  HopArc,
  House,
  Lighthouse,
  Mailbox,
  Mover,
  PaperPlane,
  arc,
  circlePath,
  motion as m,
  onCircle,
  useMotionAllowed,
} from '../illustrations';
import styles from './HeroPlanet.module.css';

const P = {cx: 400, cy: 420, r: 240};

type Spot = {
  deg: number;
  kind: 'house' | 'tall' | 'gate' | 'host';
  door?: 'closed' | 'swing';
  waves?: boolean;
};

const RING: Spot[] = [
  {deg: 0, kind: 'gate'},
  {deg: 36, kind: 'tall'},
  {deg: 72, kind: 'house', door: 'swing'},
  {deg: 108, kind: 'house'},
  {deg: 144, kind: 'tall', waves: true},
  {deg: 180, kind: 'host'},
  {deg: 216, kind: 'house'},
  {deg: 252, kind: 'tall'},
  {deg: 288, kind: 'house', waves: true},
  {deg: 324, kind: 'house'},
];

const inner = (deg: number, r = 224) => onCircle(P.cx, P.cy, r, deg);

/**
 * The signature scene: a little planet of homes. Media (paper planes) hops across the globe
 * from home to home; only small sealed envelopes go to the gate on top. The ring of homes
 * turns as the page scrolls (driven by the --fh-spin custom property on an ancestor).
 */
export default function HeroPlanet() {
  const motion = useMotionAllowed();
  const id = useId().replace(/:/g, '');
  const hops = [arc(inner(252), inner(108), 92), arc(inner(144), inner(216), -66), arc(inner(288), inner(126), 38)];
  const mail = [arc([236, 122], [380, 66], 42), arc([564, 122], [420, 66], -42)];
  const text = [
    {r: 196, words: 'YOUR SERVERS'},
    {r: 153, words: 'NEVER CARRY'},
    {r: 110, words: 'THE CALL'},
  ];
  return (
    <svg className={styles.svg} viewBox="0 0 800 800" role="img" aria-labelledby={`${id}-t`}>
      <title id={`${id}-t`}>
        A small blue planet ringed by homes. Paper planes fly across the planet from home to home while sealed
        envelopes go to a mailbox labelled gate on top. Text on the planet reads: your servers never carry the call.
      </title>
      <defs>
        {text.map(t => (
          <path key={t.r} id={`${id}-arc-${t.r}`} d={circlePath(P.cx, P.cy, t.r, -80, 80)} />
        ))}
      </defs>

      <g className={styles.far}>
        <Cloud x={96} y={170} scale={0.9} className={m.drift} />
        <Cloud x={716} y={318} scale={0.72} flip className={m.driftLate} />
      </g>

      <circle cx={P.cx} cy={P.cy} r={P.r} fill={C.azure} stroke={C.ink} strokeWidth={6} />

      <g fontFamily={DISPLAY_FONT} fill={C.white} letterSpacing={2} fontSize={43}>
        {text.map(t => (
          <text key={t.r}>
            <textPath href={`#${id}-arc-${t.r}`} startOffset="50%" textAnchor="middle">
              {t.words}
            </textPath>
          </text>
        ))}
      </g>

      <g className={styles.ring}>
        {hops.map((h, i) => (
          <HopArc key={i} arc={h} color={C.white} width={5.5} slow={i === 1} />
        ))}
        {mail.map((h, i) => (
          <HopArc key={i} arc={h} pattern="dashes" slow />
        ))}
        {RING.map(s => {
          const [x, y] = onCircle(P.cx, P.cy, P.r - 1, s.deg);
          if (s.kind === 'gate') return <Mailbox key={s.deg} x={x} y={y} scale={1.3} flag="anim" />;
          if (s.kind === 'host') return <Lighthouse key={s.deg} x={x} y={y} rotate={s.deg} scale={0.74} beams={false} />;
          return (
            <House
              key={s.deg}
              x={x}
              y={y}
              rotate={s.deg}
              scale={s.kind === 'tall' ? 1.02 : 1.12}
              variant={s.kind === 'tall' ? 'tall' : 'house'}
              flip={s.deg > 180}
              door={s.door}
              waves={s.waves}
            />
          );
        })}
        <Mover arc={hops[0]} dur={3.4} rest={0.52} motion={motion}>
          <PaperPlane scale={1.35} fold={C.yellow} />
        </Mover>
        <Mover arc={hops[1]} dur={4.4} begin={-2} rest={0.4} motion={motion}>
          <PaperPlane scale={1.2} fold={C.yellow} />
        </Mover>
        <Mover arc={hops[2]} dur={3.9} begin={-1} rest={0.7} motion={motion}>
          <PaperPlane scale={1.2} fold={C.yellow} />
        </Mover>
        <Mover arc={mail[0]} dur={4} travel={0.45} rest={0.55} orient={false} motion={motion}>
          <Envelope scale={0.95} />
        </Mover>
        <Mover arc={mail[1]} dur={4} begin={2} travel={0.45} rest={0.45} orient={false} motion={motion}>
          <Envelope scale={0.95} />
        </Mover>
      </g>

      <g className={styles.near}>
        <Cloud x={652} y={736} scale={1} className={m.driftLate} />
        <Cloud x={132} y={700} scale={0.66} flip className={m.drift} />
      </g>
    </svg>
  );
}
