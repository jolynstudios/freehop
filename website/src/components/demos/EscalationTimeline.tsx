import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import clsx from 'clsx';
import PathBadge, {type PathKind} from '../PathBadge';
import {C, PaperPlane} from '../illustrations';
import d from './demo.module.css';
import s from './EscalationTimeline.module.css';

// Budgets from the client's DEFAULT_TIMING (src/client/room.mjs).
const ENDPOINT = 5;
const GRACE = 5;
const SESSION = 7;
const BRIDGE = 4;
const RETRIES = [30, 60, 120, 240, 300];

type Scenario = {id: string; label: string; ends: 0 | 1 | 2 | 3; kind: PathKind};
const SCENARIOS: Scenario[] = [
  {id: 'direct', label: 'Direct works', ends: 0, kind: 'direct'},
  {id: 'gateway', label: "Other side's own gateway", ends: 0, kind: 'gateway'},
  {id: 'relay', label: 'Host node relays', ends: 1, kind: 'relay'},
  {id: 'bridged', label: 'A participant bridges', ends: 2, kind: 'bridged'},
  {id: 'unreachable', label: 'Nothing works', ends: 3, kind: 'unreachable'},
];

const PHASES = [
  {
    name: 'Phase 0: endpoints',
    budget: '5 s',
    servers: "Application-approved STUN, your own gateway and the other side's gateway.",
    routes: 'Direct (LAN, IPv6, STUN reflexive) or one endpoint’s own gateway.',
    leaves: 'Not connected 5 s after the description, plus one 5 s grace period if connectivity checks get answers.',
  },
  {
    name: 'Phase 1: session gateways',
    budget: '7 s',
    servers: 'Adds up to two gateways of other members: a desktop participant or the host node.',
    routes: 'Relay through a session gateway, still encrypted end to end.',
    leaves:
      'Only the impolite peer restarts ICE; the polite one takes over after 2.5 s. Not connected after 7 s, plus one 7 s grace period if checks get answers.',
  },
  {
    name: 'Phase 2: bridging',
    budget: 'until a route appears',
    servers: 'Unchanged.',
    routes: 'A connected participant forwards the media. The lower peer id asks; the other side takes over after 4 s.',
    leaves: 'When the direct or session route later connects, the bridge is released.',
  },
  {
    name: 'Unreachable',
    budget: '30 s to 5 min',
    servers: 'Unchanged.',
    routes: 'None inside the session. Freehop reports it instead of renting a relay.',
    leaves: 'ICE restarts after 30 s, 60 s, 120 s, 240 s, then every 300 s. New members or a network change can open a route.',
  },
];

/** Step through the path ladder's timers for a pair of peers. */
export default function EscalationTimeline() {
  const [scenario, setScenario] = useState<Scenario>(SCENARIOS[2]);
  const [grace, setGrace] = useState(false);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const frame = useRef(0);
  const last = useRef(0);

  // Simulated seconds at which each phase ends, given the scenario and the grace toggle.
  const marks = useMemo(() => {
    const p0 = ENDPOINT + (grace ? GRACE : 0);
    const p1 = p0 + SESSION + (grace ? SESSION : 0);
    const p2 = p1 + BRIDGE;
    const end = scenario.ends === 0 ? p0 * 0.55 : scenario.ends === 1 ? p0 + SESSION * 0.5 : scenario.ends === 2 ? p1 + BRIDGE * 0.8 : p2 + 2;
    return {p0, p1, p2, end};
  }, [scenario, grace]);

  const phase = t < marks.p0 ? 0 : t < marks.p1 ? 1 : t < marks.p2 ? 2 : 3;
  const done = t >= marks.end;
  const active = Math.min(phase, scenario.ends);

  // Track geometry: the first 16 seconds are linear, the retry area is compressed.
  const span = marks.p2 + 3;
  const pos = (sec: number) => (Math.min(sec, span) / span) * 82;

  const stop = useCallback(() => {
    cancelAnimationFrame(frame.current);
    setPlaying(false);
  }, []);

  useEffect(() => {
    if (!playing) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setT(marks.end);
      setPlaying(false);
      return;
    }
    last.current = performance.now();
    const tick = (now: number) => {
      const dt = (now - last.current) / 1000;
      last.current = now;
      setT((prev) => {
        const next = Math.min(prev + dt * 3.2, marks.end);
        if (next >= marks.end) setPlaying(false);
        return next;
      });
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [playing, marks.end]);

  const play = () => {
    if (done) setT(0);
    setPlaying(true);
  };
  const step = () => {
    stop();
    const stops = [marks.p0, marks.p1, marks.p2, marks.end].filter((v) => v > t + 0.01).sort((a, b) => a - b);
    setT(Math.min(stops[0] ?? marks.end, marks.end));
  };
  const reset = () => {
    stop();
    setT(0);
  };
  const choose = (sc: Scenario) => {
    stop();
    setScenario(sc);
    setT(0);
  };

  const markerLeft = phase === 3 ? 88 : pos(t);
  const status = done ? (scenario.kind === 'unreachable' ? 'Unreachable: retrying with backoff' : `Connected: ${scenario.kind}`) : PHASES[phase].name;

  return (
    <div className={clsx(d.card, s.timeline)}>
      <div className={d.cardHead}>
        <p className={d.cardTitle}>Escalation timeline</p>
        <div className={s.buttons}>
          <button type="button" className={clsx(s.play, playing && s.playing)} onClick={playing ? stop : play}>
            {playing ? 'Pause' : done ? 'Replay' : 'Play'}
          </button>
          <button type="button" className={d.ghostButton} onClick={step}>
            Next step
          </button>
          <button type="button" className={d.ghostButton} onClick={reset}>
            Reset
          </button>
        </div>
      </div>
      <div className={d.cardBody}>
        <div className={s.controls}>
          <div className={d.chips} role="radiogroup" aria-label="What works for this pair">
            {SCENARIOS.map((sc) => (
              <label key={sc.id} className={d.chip}>
                <input type="radio" name="fh-escalation" checked={scenario.id === sc.id} onChange={() => choose(sc)} />
                <span>{sc.label}</span>
              </label>
            ))}
          </div>
          <label className={d.switch}>
            <input
              type="checkbox"
              checked={grace}
              onChange={() => {
                setGrace((g) => !g);
                setT(0);
                stop();
              }}
            />
            <span className={d.track} aria-hidden="true" />
            Checks get answers (grace period)
          </label>
        </div>

        <div className={s.trackWrap}>
          <div className={s.track} aria-hidden="true">
            <span className={clsx(s.seg, s.seg0)} style={{left: 0, width: `${pos(ENDPOINT)}%`}} />
            {grace && <span className={clsx(s.seg, s.segGrace)} style={{left: `${pos(ENDPOINT)}%`, width: `${pos(GRACE)}%`}} />}
            <span className={clsx(s.seg, s.seg1)} style={{left: `${pos(marks.p0)}%`, width: `${pos(marks.p1 - marks.p0)}%`}} />
            <span className={clsx(s.seg, s.seg2)} style={{left: `${pos(marks.p1)}%`, width: `${82 - pos(marks.p1)}%`}} />
            <span className={clsx(s.seg, s.seg3)} style={{left: '84%', width: '16%'}} />
            <span className={s.break} style={{left: '82.4%'}} />
            {[0, ENDPOINT, ...(grace ? [marks.p0] : []), marks.p1].map((sec) => (
              <span key={sec} className={s.tick} style={{left: `${pos(sec)}%`}}>
                {sec} s
              </span>
            ))}
            {RETRIES.map((sec, i) => (
              <span
                key={sec}
                className={clsx(s.retry, phase === 3 && done && s.retryOn)}
                style={{left: `${85 + i * 3.4}%`, animationDelay: `${i * 0.25}s`}}
                title={`retry after ${sec} s`}
              />
            ))}
            <span className={clsx(s.marker, playing && s.markerMoving)} style={{left: `${markerLeft}%`}}>
              <svg viewBox="-26 -18 52 36" width="40" height="28">
                <path d="M-16 0 0-10 16 0 0 10Z" fill="#9fbcff" stroke="#101522" strokeWidth={2} />
              </svg>
            </span>
          </div>
          <div className={s.retryLabel}>retries: 30 s, 60 s, 120 s, 240 s, then every 5 min</div>
        </div>

        <div className={s.status} aria-live="polite">
          <span className={s.statusText}>{status}</span>
          {done && <PathBadge key={scenario.id} kind={scenario.kind} size="lg" className={d.pop} />}
        </div>

        <ol className={s.phases}>
          {PHASES.map((p, i) => {
            const state =
              i < active || (i === active && done && scenario.kind === 'unreachable' && i < 3)
                ? 'past'
                : i === active
                  ? 'now'
                  : i > scenario.ends
                    ? 'skipped'
                    : 'next';
            return (
              <li key={p.name} className={clsx(s.phase, s[state])}>
                <div className={s.phaseHead}>
                  <span className={s.phaseName}>{p.name}</span>
                  <span className={s.budget}>{p.budget}</span>
                </div>
                <dl>
                  <dt>ICE servers</dt>
                  <dd>{p.servers}</dd>
                  <dt>Route</dt>
                  <dd>{p.routes}</dd>
                  <dt>Moves on when</dt>
                  <dd>{p.leaves}</dd>
                </dl>
              </li>
            );
          })}
        </ol>
        <p className={s.note}>
          Phase budgets come from the client's defaults; connection times here are illustrative. The 4-second bridge wait is an initiator fallback, not a
          deadline that proves a pair unreachable. A phase with no eligible gateway or bridge can be skipped. Working routes are used as soon as they connect.
        </p>
      </div>
    </div>
  );
}
