import {useId, useMemo, useState} from 'react';
import clsx from 'clsx';
import PathBadge from '../PathBadge';
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

function Scene({a, b, x, v}: {a: Net; b: Net; x: Extras; v: Verdict}) {
  const connected = v.kind !== 'unreachable';
  const via = v.via ?? (connected ? 'Direct peer connection' : 'No available session route');
  return (
    <svg className={d.stageSvg} viewBox="0 0 760 330" role="img" aria-label={`${NETS[a].label} to ${NETS[b].label}: ${v.kind}`}>
      <rect width="760" height="330" fill="#0b0b0c" />
      <path d="M160 182 380 68 600 182" fill="none" stroke="#777777" strokeDasharray="5 7" />
      <rect x="324" y="42" width="112" height="48" rx="4" fill="#141416" stroke="#777777" />
      <text x="380" y="71" textAnchor="middle" fill="#c6c6c6" fontFamily="monospace" fontSize="14">
        GATE
      </text>
      <path d="M195 197H565" stroke={connected ? '#c6c6c6' : '#f398ac'} strokeWidth="2" strokeDasharray={connected ? undefined : '5 8'} />
      {[
        {x: 75, name: 'ANA', net: a},
        {x: 565, name: 'BEN', net: b},
      ].map((n) => (
        <g key={n.name}>
          <rect x={n.x} y="144" width="120" height="104" rx="5" fill="#202024" stroke="#c6c6c6" />
          <text x={n.x + 60} y="183" textAnchor="middle" fill="#f0f0f0" fontFamily="monospace" fontSize="17">
            {n.name}
          </text>
          <text x={n.x + 60} y="219" textAnchor="middle" fill="#c6c6c6" fontFamily="monospace" fontSize="12">
            {NETS[n.net].tag}
          </text>
        </g>
      ))}
      <rect x="258" y="166" width="244" height="62" rx="4" fill="#0b0b0c" stroke="#414145" />
      <text x="380" y="190" textAnchor="middle" fill={connected ? '#85d9ca' : '#f398ac'} fontFamily="monospace" fontSize="14">
        {v.kind.toUpperCase()}
      </text>
      <text x="380" y="212" textAnchor="middle" fill="#c6c6c6" fontFamily="monospace" fontSize="11">
        {via}
      </text>
      <text x="380" y="295" textAnchor="middle" fill="#a1a4a5" fontFamily="monospace" fontSize="11">
        HOST {x.host ? 'ON' : 'OFF'} / DESKTOP {x.desktop ? 'ON' : 'OFF'} / THIRD PEER {x.third ? 'ON' : 'OFF'}
      </text>
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
  const toggle = (k: keyof Extras) => setX((prev) => ({...prev, [k]: !prev[k]}));
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
        {ORDER.map((n) => (
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
        <p>
          Illustrative network model, not a test of your connection. Figures below come from Freehop's original home-lab network tests, before the later
          security fixes.
        </p>
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
                <dt>Home-lab test evidence</dt>
                <dd>
                  {v.lab ? (
                    <>
                      <span className={d.kbd}>{v.lab.scenario}</span> {v.lab.runs} passed, gate traffic {v.lab.gate} per run.
                      {v.lab.note && ` ${v.lab.note}`}
                    </>
                  ) : (
                    'No matching home-lab test scenario; this follows the same routing rules.'
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
