import {useId, useMemo, useState} from 'react';
import clsx from 'clsx';
import PathBadge from '../PathBadge';
import {
  Bubble,
  C,
  Cloud,
  Envelope,
  HopArc,
  House,
  Lighthouse,
  Mailbox,
  Mover,
  NameTag,
  PaperPlane,
  Person,
  Wall,
  arc,
  line,
  motion as m,
  useMotionAllowed,
  type Arc,
  type Pt,
} from '../illustrations';
import {NETS, decide, type Extras, type Net, type Verdict} from './pathRules';
import d from './demo.module.css';
import s from './PathFinder.module.css';

const ORDER: Net[] = ['home', 'strict', 'udp', 'v6', 'upnp', 'gateonly'];
const DEFAULTS = {a: 'strict' as Net, b: 'strict' as Net, x: {desktop: false, host: true, third: false} as Extras};

const PHASE_LABEL: Record<string, string> = {
  '0': 'Phase 0: endpoints, first 5 s',
  '1': 'Phase 1: session gateways, next 7 s',
  '2': 'Phase 2: bridging, after the gateways',
  null: 'Retries: every 30 s, backing off to 5 min',
};

/** The first part of a quadratic arc, up to parameter t (de Casteljau). */
function head(a: Arc, t: number): Arc {
  const c: Pt = [a.a[0] + (a.c[0] - a.a[0]) * t, a.a[1] + (a.c[1] - a.a[1]) * t];
  const u = 1 - t;
  const b: Pt = [u * u * a.a[0] + 2 * u * t * a.c[0] + t * t * a.b[0], u * u * a.a[1] + 2 * u * t * a.c[1] + t * t * a.b[1]];
  return {a: a.a, b, c, d: `M${a.a[0]} ${a.a[1]} Q${c[0]} ${c[1]} ${b[0]} ${b[1]}`};
}

function Home({net, x, flip, name}: {net: Net; x: number; flip?: boolean; name: string}) {
  const y = 290;
  return (
    <g>
      {net === 'udp' || net === 'gateonly' ? (
        <House x={x} y={y} scale={0.86} variant="tall" flip={flip} />
      ) : (
        <House
          x={x}
          y={y}
          scale={0.95}
          flip={flip}
          door={net === 'upnp' ? 'swing' : 'closed'}
          waves={net === 'upnp'}
          flag={net === 'v6' ? C.azure : undefined}
        />
      )}
      {net === 'gateonly' && <Wall x={x - 62} y={196} width={124} height={96} slot={[x, 244]} course={16} brick={34} />}
      <Bubble x={x + (flip ? -8 : 8)} y={net === 'udp' || net === 'gateonly' ? 140 : 162} text={NETS[net].tag} size={14} fill={net === 'upnp' ? C.azure : C.white} color={net === 'upnp' ? C.white : C.ink} />
      <NameTag x={x} y={311} text={name} size={15} />
    </g>
  );
}

function Scene({a, b, x, v}: {a: Net; b: Net; x: Extras; v: Verdict}) {
  const motion = useMotionAllowed();
  const A: Pt = [118, 226];
  const B: Pt = [642, 226];
  const anaDoor: Pt = [100, 270];
  const benDoor: Pt = [660, 270];
  const lamp: Pt = [226, 196];
  const daniDoor: Pt = [548, 270];
  const cleoL: Pt = [354, 206];
  const cleoR: Pt = [406, 206];

  let legs: Arc[] = [];
  let broken: Arc | null = null;
  if (v.kind === 'direct') legs = [arc(A, B, 124)];
  else if (v.kind === 'gateway') legs = [v.via === 'Ben' ? arc(A, benDoor, 112) : arc(B, anaDoor, -112)];
  else if (v.kind === 'relay' && v.via === 'host node') legs = [arc(A, lamp, 34), arc(lamp, B, 92)];
  else if (v.kind === 'relay') legs = [arc(A, daniDoor, 86), arc(daniDoor, B, 40)];
  else if (v.kind === 'bridged') legs = [arc(A, cleoL, 52), arc(cleoR, B, 52)];
  else broken = head(arc(A, B, 124), 0.4);

  const mail = [arc([132, 196], [366, 52], 56), arc([628, 196], [394, 52], -56)];
  const key = `${a}-${b}-${v.kind}-${v.via ?? ''}`;

  return (
    <svg className={d.stageSvg} viewBox="0 0 760 330" role="img" aria-label={`${NETS[a].label} to ${NETS[b].label}: ${v.kind}${v.via ? ' via ' + v.via : ''}.`}>
      <path d="M-10 300 Q380 246 770 300 V340 H-10 Z" fill={C.azure} stroke={C.ink} strokeWidth={5} strokeLinejoin="round" />
      <Cloud x={380} y={130} scale={1.15} />
      <Mailbox x={380} y={104} scale={0.56} flag="anim" />
      {mail.map((h, i) => (
        <HopArc key={i} arc={h} pattern="dashes" slow />
      ))}
      <Mover arc={mail[0]} dur={6} travel={0.35} rest={0.6} orient={false} motion={motion}>
        <Envelope scale={0.55} />
      </Mover>
      <Mover arc={mail[1]} dur={6} begin={3} travel={0.35} rest={0.6} orient={false} motion={motion}>
        <Envelope scale={0.55} />
      </Mover>

      <g className={clsx(s.extra, x.host ? s.on : s.off)}>
        <Lighthouse x={226} y={288} scale={0.62} beams={false} />
        <NameTag x={226} y={311} text="HOST" size={14} />
      </g>
      <g className={clsx(s.extra, x.desktop ? s.on : s.off)}>
        <House x={548} y={286} scale={0.78} door="open" waves flip />
        <NameTag x={548} y={311} text="DANI" size={14} />
      </g>
      <g className={clsx(s.extra, x.third ? s.on : s.off)}>
        <Person x={380} y={282} scale={0.88} arms="up" />
        <NameTag x={380} y={311} text="CLEO" size={14} />
      </g>

      <Home net={a} x={82} name="ANA" />
      <Home net={b} x={678} name="BEN" flip />

      <g key={key} className={s.route}>
        {legs.map((leg, i) => (
          <HopArc key={i} arc={leg} width={5} />
        ))}
        {legs.map((leg, i) => (
          <Mover key={`p${i}`} arc={leg} dur={legs.length > 1 ? 4 : 3.2} begin={i * 2} travel={legs.length > 1 ? 0.5 : 1} rest={0.55} motion={motion}>
            {v.kind === 'bridged' ? <circle r={9} fill={C.coral} {...line} strokeWidth={3} /> : <PaperPlane scale={0.9} />}
          </Mover>
        ))}
        {broken && (
          <g>
            <HopArc arc={broken} width={5} />
            <g transform={`translate(${broken.b[0]} ${broken.b[1]})`}>
              <circle r={17} fill={C.white} {...line} strokeWidth={3.5} />
              <path d="M-7 -7 L7 7 M7 -7 L-7 7" {...line} stroke={C.coral} strokeWidth={5} />
            </g>
          </g>
        )}
      </g>
    </svg>
  );
}

/** Pick two networks and who else is in the call; see which route Freehop takes and why. */
export default function PathFinder() {
  const id = useId();
  const [a, setA] = useState<Net>(DEFAULTS.a);
  const [b, setB] = useState<Net>(DEFAULTS.b);
  const [x, setX] = useState<Extras>(DEFAULTS.x);
  const v = useMemo(() => decide(a, b, x), [a, b, x]);
  const toggle = (k: keyof Extras) => setX(prev => ({...prev, [k]: !prev[k]}));
  const reset = () => {
    setA(DEFAULTS.a);
    setB(DEFAULTS.b);
    setX(DEFAULTS.x);
  };

  const group = (who: 'Ana' | 'Ben', value: Net, set: (n: Net) => void) => (
    <fieldset className={d.fieldset}>
      <legend className={d.legend}>
        {who}'s network <span className={d.legendNote}>{NETS[value].hint}</span>
      </legend>
      <div className={d.chips} role="radiogroup">
        {ORDER.map(n => (
          <label key={n} className={d.chip}>
            <input type="radio" name={`${id}-${who}`} value={n} checked={value === n} onChange={() => set(n)} />
            <span>{NETS[n].label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );

  return (
    <div className={clsx(d.card, s.finder)}>
      <div className={d.cardHead}>
        <p className={d.cardTitle}>Path finder</p>
        <button type="button" className={d.ghostButton} onClick={reset}>
          Reset
        </button>
      </div>
      <div className={clsx(d.cardBody, s.body)}>
        <div className={s.controls}>
          {group('Ana', a, setA)}
          {group('Ben', b, setB)}
          <fieldset className={d.fieldset}>
            <legend className={d.legend}>Also in the session</legend>
            <div className={d.switches}>
              <label className={d.switch}>
                <input type="checkbox" checked={x.desktop} onChange={() => toggle('desktop')} />
                <span className={d.track} aria-hidden="true" />
                Dani, on the desktop app with a reachable gateway
              </label>
              <label className={d.switch}>
                <input type="checkbox" checked={x.host} onChange={() => toggle('host')} />
                <span className={d.track} aria-hidden="true" />
                The session's host node
              </label>
              <label className={d.switch}>
                <input type="checkbox" checked={x.third} onChange={() => toggle('third')} />
                <span className={d.track} aria-hidden="true" />
                Cleo, a participant on an open connection
              </label>
            </div>
          </fieldset>
        </div>
        <div className={s.split}>
          <div className={clsx(d.stage, s.stage)}>
            <Scene a={a} b={b} x={x} v={v} />
          </div>
          <div className={s.result} aria-live="polite">
            <div key={`${v.kind}-${v.via}`} className={clsx(s.outcome, d.pop)}>
              <PathBadge kind={v.kind} via={v.via} size="lg" />
            </div>
            <h3 className={s.headline}>{v.headline}</h3>
            <p className={s.why}>{v.why}</p>
            <dl className={s.facts}>
              <div>
                <dt>When</dt>
                <dd>{PHASE_LABEL[String(v.phase)]}</dd>
              </div>
              <div>
                <dt>Your servers</dt>
                <dd>Sealed signalling only. Media bytes: 0.</dd>
              </div>
              <div>
                <dt>Lab evidence</dt>
                <dd>
                  {v.lab ? (
                    <>
                      <span className={d.kbd}>{v.lab.scenario}</span> {v.lab.runs} passed, gate traffic {v.lab.gate} per run.
                      {v.lab.note && ` ${v.lab.note}`}
                    </>
                  ) : (
                    'Not a lab scenario as such: this follows the same rules.'
                  )}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}
