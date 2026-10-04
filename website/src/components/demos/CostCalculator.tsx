import {useId, useMemo, useState, type ReactNode} from 'react';
import clsx from 'clsx';
import d from './demo.module.css';
import s from './CostCalculator.module.css';

// Illustrative direct-pair setup estimate; retries and more complex paths can cost more.
const KB_PER_PAIR = 35;

const MEDIA = [
  {id: 'voice', label: 'Voice', kbps: 32},
  {id: 'video', label: 'Voice and video', kbps: 332},
] as const;

const SOURCES = [
  {
    label: 'Cloudflare Realtime TURN pricing: monthly free allowance, then $0.05/GB for standalone TURN',
    href: 'https://developers.cloudflare.com/realtime/turn/faq/',
  },
];

function bytes(gb: number) {
  if (!Number.isFinite(gb) || gb <= 0) return {value: '0', unit: 'GB'};
  if (gb >= 1000) return {value: (gb / 1000).toLocaleString('en-US', {maximumFractionDigits: gb >= 10000 ? 0 : 1}), unit: 'TB'};
  if (gb >= 1) return {value: gb.toLocaleString('en-US', {maximumFractionDigits: gb >= 100 ? 0 : 1}), unit: 'GB'};
  return {value: (gb * 1000).toLocaleString('en-US', {maximumFractionDigits: gb * 1000 >= 100 ? 0 : 1}), unit: 'MB'};
}

function money(usd: number) {
  if (!Number.isFinite(usd)) return '$0';
  return '$' + usd.toLocaleString('en-US', {maximumFractionDigits: usd >= 100 ? 0 : 2, minimumFractionDigits: 0});
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
// Concurrent people: a log slider from 10 to 100,000.
const toSlider = (people: number) => Math.round(((Math.log10(clamp(people, 10, 100000)) - 1) / 4) * 1000);
const fromSlider = (v: number) => {
  const raw = Math.pow(10, 1 + (v / 1000) * 4);
  const step = raw >= 10000 ? 1000 : raw >= 1000 ? 100 : raw >= 100 ? 10 : 1;
  return Math.round(raw / step) * step;
};

function Field({label, note, children, htmlFor}: {label: string; note?: ReactNode; children: ReactNode; htmlFor: string}) {
  return (
    <div className={s.field}>
      <label className={s.fieldLabel} htmlFor={htmlFor}>
        {label}
      </label>
      <div className={s.fieldControl}>{children}</div>
      {note && <p className={s.fieldNote}>{note}</p>}
    </div>
  );
}

/** Illustrate a separate TURN provider's egress and Freehop gate signalling traffic. */
export default function CostCalculator() {
  const id = useId();
  const [people, setPeople] = useState(1000);
  const [hours, setHours] = useState(240);
  const [share, setShare] = useState(0);
  const [kbps, setKbps] = useState(332);
  const [group, setGroup] = useState(2);
  const [minutes, setMinutes] = useState(30);
  const [price, setPrice] = useState(0.05);
  const [allowanceGB, setAllowanceGB] = useState(1000);

  const r = useMemo(() => {
    const personHours = people * hours;
    const relayed = personHours * (share / 100);
    const relayGB = (relayed * (group - 1) * kbps * 1000 * 3600) / 8 / 1e9;
    const calls = (personHours * 60) / (minutes * group);
    const pairs = (group * (group - 1)) / 2;
    const gateGB = (calls * pairs * KB_PER_PAIR * 1000) / 1e9;
    const billableGB = Math.max(0, relayGB - allowanceGB);
    return {personHours, relayed, relayGB, billableGB, cost: billableGB * price, calls, gateGB, ratio: relayGB > 0 ? gateGB / relayGB : 0};
  }, [people, hours, share, kbps, group, minutes, price, allowanceGB]);

  const relay = bytes(r.relayGB);
  const gate = bytes(r.gateGB);
  const gateWidth = r.relayGB > 0 ? Math.max(Math.min(r.ratio * 100, 100), 0.6) : 0;

  return (
    <div className={clsx(d.card, s.calc)}>
      <div className={d.cardHead}>
        <p className={d.cardTitle}>Relay bill estimate</p>
        <span className={s.estimate}>Estimate. Every assumption is editable.</span>
      </div>
      <div className={clsx(d.cardBody, s.body)}>
        <div className={s.inputs}>
          <Field label="People in calls at the same time" htmlFor={`${id}-people`} note="Average across the hours below.">
            <input
              type="range"
              min={0}
              max={1000}
              value={toSlider(people)}
              onChange={e => setPeople(fromSlider(Number(e.target.value)))}
              aria-label="People in calls at the same time, slider"
              className={s.range}
            />
            <input
              id={`${id}-people`}
              type="number"
              min={1}
              max={1000000}
              value={people}
              onChange={e => setPeople(clamp(Number(e.target.value), 1, 1000000))}
              className={s.number}
            />
          </Field>
          <Field label="Hours per month at that level" htmlFor={`${id}-hours`} note="240 hours is 8 hours a day.">
            <input type="range" min={1} max={744} value={hours} onChange={e => setHours(Number(e.target.value))} aria-label="Hours per month, slider" className={s.range} />
            <input id={`${id}-hours`} type="number" min={1} max={744} value={hours} onChange={e => setHours(clamp(Number(e.target.value), 1, 744))} className={s.number} />
          </Field>
          <Field
            label="Share of participant-hours using TURN"
            htmlFor={`${id}-share`}
            note={
              <>
                Set this from your own route measurements. The default 0% is only a neutral starting point, not a usage claim.
              </>
            }>
            <input type="range" min={0} max={60} value={share} onChange={e => setShare(Number(e.target.value))} aria-label="Relay share, slider" className={s.range} />
            <span className={s.withUnit}>
              <input id={`${id}-share`} type="number" min={0} max={100} value={share} onChange={e => setShare(clamp(Number(e.target.value), 0, 100))} className={s.number} />
              <span>%</span>
            </span>
          </Field>
          <Field label="Media per stream" htmlFor={`${id}-kbps`} note="Freehop's caps: Opus audio 32 kbit/s, video 300 kbit/s per link.">
            <div className={s.presets} role="group" aria-label="Media presets">
              {MEDIA.map(m => (
                <button key={m.id} type="button" className={clsx(s.preset, kbps === m.kbps && s.presetOn)} aria-pressed={kbps === m.kbps} onClick={() => setKbps(m.kbps)}>
                  {m.label}
                </button>
              ))}
            </div>
            <span className={s.withUnit}>
              <input id={`${id}-kbps`} type="number" min={8} max={8000} value={kbps} onChange={e => setKbps(clamp(Number(e.target.value), 8, 8000))} className={s.number} />
              <span>kbit/s</span>
            </span>
          </Field>
          <Field label="People per call" htmlFor={`${id}-group`} note="Each person receives the other people's streams.">
            <input type="range" min={2} max={8} value={group} onChange={e => setGroup(Number(e.target.value))} aria-label="People per call, slider" className={s.range} />
            <input id={`${id}-group`} type="number" min={2} max={8} value={group} onChange={e => setGroup(clamp(Number(e.target.value), 2, 8))} className={s.number} />
          </Field>
          <Field label="Average call length" htmlFor={`${id}-minutes`} note="Sets how many call setups the gates handle.">
            <input type="range" min={1} max={180} value={minutes} onChange={e => setMinutes(Number(e.target.value))} aria-label="Call length, slider" className={s.range} />
            <span className={s.withUnit}>
              <input id={`${id}-minutes`} type="number" min={1} max={600} value={minutes} onChange={e => setMinutes(clamp(Number(e.target.value), 1, 600))} className={s.number} />
              <span>min</span>
            </span>
          </Field>
          <Field label="TURN egress price per GB" htmlFor={`${id}-price`} note="Enter your provider's rate after any free allowance or bundle.">
            <span className={s.withUnit}>
              <span>$</span>
              <input id={`${id}-price`} type="number" min={0} step={0.01} value={price} onChange={e => setPrice(clamp(Number(e.target.value), 0, 100))} className={s.number} />
              <span>per GB</span>
            </span>
          </Field>
          <Field label="Monthly free egress allowance" htmlFor={`${id}-allowance`} note="Cloudflare Realtime TURN currently includes 1,000 GB/month; change this for your provider or plan.">
            <span className={s.withUnit}>
              <input id={`${id}-allowance`} type="number" min={0} step={100} value={allowanceGB} onChange={e => setAllowanceGB(clamp(Number(e.target.value), 0, 1000000))} className={s.number} />
              <span>GB</span>
            </span>
          </Field>
        </div>

        <div className={s.outputs} aria-live="polite">
          <div className={clsx(s.result, s.classic)}>
            <p className={s.resultLabel}>Separate TURN service or server</p>
            <p className={s.big}>
              {relay.value}
              <span className={s.unit}>{relay.unit} / month</span>
            </p>
            <p className={s.bill}>
              {money(r.cost)} <span>estimated egress, before other fees</span>
            </p>
            <div className={s.bar} aria-hidden="true">
              <span className={s.barFill} style={{width: r.relayGB > 0 ? '100%' : '0%'}} />
            </div>
          </div>
          <div className={clsx(s.result, s.freehop)}>
            <p className={s.resultLabel}>Freehop gate-only path</p>
            <p className={s.big}>
              0<span className={s.unit}>GB of media through your gate</span>
            </p>
            <p className={s.bill}>
              $0 <span>TURN egress through the gate</span>
            </p>
            <div className={s.bar} aria-hidden="true">
              <span className={clsx(s.barFill, s.barGate)} style={{width: `${gateWidth}%`}} />
            </div>
            <p className={s.gateLine}>
              Gates: about <strong>{gate.value} {gate.unit}</strong> of sealed signalling a month
              {r.relayGB > 0 && <>, {(r.ratio * 100).toLocaleString('en-US', {maximumFractionDigits: r.ratio < 0.001 ? 3 : 2})}% of the relay traffic</>}.
            </p>
          </div>
          <p className={s.who}>
            This Freehop column assumes the media gateway belongs to a participant and the gate carries signalling only. It excludes
            hosting your backend or gate. If you run the session host or gateway on infrastructure you pay for, its media bandwidth and
            compute can still appear on your bill.
          </p>
          <details className={s.math}>
            <summary>How this is calculated</summary>
            <ul>
              <li>
                Person-hours: {Math.round(r.personHours).toLocaleString('en-US')}; relayed: {Math.round(r.relayed).toLocaleString('en-US')} ({share}%).
              </li>
              <li>Relay traffic: each relayed person receives {group - 1} stream{group > 2 ? 's' : ''} at {kbps} kbit/s through the relay.</li>
              <li>
                Gates: {Math.round(r.calls).toLocaleString('en-US')} calls of {minutes} min, {(group * (group - 1)) / 2} peer pair{group > 2 ? 's' : ''} each, an assumed {KB_PER_PAIR} KB per pair at setup. Excludes keepalives, discovery, retries, protocol overhead and hosting costs; complex paths can use more.
              </li>
              <li>TURN estimate: {relay.value} {relay.unit} total egress less {allowanceGB.toLocaleString('en-US')} GB included, charged at {money(price)}/GB. Provider bundles, taxes and other fees are excluded.</li>
            </ul>
          </details>
        </div>
      </div>
      <div className={s.sources}>
        <span className={s.sourcesLabel}>Sources</span>
        <ul>
          {SOURCES.map(src => (
            <li key={src.href}>
              <a href={src.href} target="_blank" rel="noopener noreferrer">
                {src.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
