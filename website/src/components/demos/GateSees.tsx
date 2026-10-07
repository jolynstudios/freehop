import {useCallback, useEffect, useMemo, useState} from 'react';
import clsx from 'clsx';
import useBaseUrl from '@docusaurus/useBaseUrl';
import {C, Envelope, Key, Mailbox} from '../illustrations';
import d from './demo.module.css';
import s from './GateSees.module.css';

// Freehop's own client crypto (static/lib/client/crypto.mjs, copied from ../src at build time).
type Room = {tag: string; key: CryptoKey};
type CryptoModule = {
  deriveRoom(secret: string, app: string): Promise<Room>;
  seal(room: Room, from: string, to: string, payload: unknown): Promise<string>;
  open(room: Room, from: string, to: string, box: string): Promise<Record<string, unknown> | null>;
  randomId(bytes?: number): string;
  toBase64Url(bytes: Uint8Array): string;
  fromBase64Url(text: string): Uint8Array;
};

type Tamper = 'none' | 'flip' | 'relabel' | 'wrongkey';
const APP = 'freehop-demo';
const DEFAULT_MESSAGE = 'Hi Ben, this is Ana. My public candidate is 203.0.113.7:51234 (srflx).';

const TAMPER: Record<Exclude<Tamper, 'none'>, {label: string; explain: string}> = {
  flip: {
    label: 'Flip one bit in the box',
    explain: 'One bit changed in transit. AES-GCM checks a 16-byte authentication tag over the whole envelope, so decryption fails and Freehop drops it.',
  },
  relabel: {
    label: 'Relabel the sender',
    explain:
      'The gate claims the envelope came from someone else. The sender id is part of the additional authenticated data, so the check fails. A gate cannot re-route or relabel envelopes without detection.',
  },
  wrongkey: {
    label: "Give Ben another room's secret",
    explain:
      "Ben's key comes from a different secret, for example the old one after a kick rotated the room. Without the current secret the envelope cannot be opened, and the room tag no longer matches either.",
  },
};

function short(id: string) {
  return id ? `${id.slice(0, 6)}…` : '…';
}

/** Highlight the characters of `next` that differ from `prev`. */
function Diff({prev, next}: {prev: string; next: string}) {
  if (prev === next) return <>{next}</>;
  let i = 0;
  while (i < next.length && next[i] === prev[i]) i++;
  let j = 0;
  while (j < next.length - i && next[next.length - 1 - j] === prev[prev.length - 1 - j]) j++;
  return (
    <>
      {next.slice(0, i)}
      <mark className={s.mark}>{next.slice(i, next.length - j)}</mark>
      {next.slice(next.length - j)}
    </>
  );
}

export default function GateSees() {
  const url = useBaseUrl('/lib/client/crypto.mjs');
  const [mod, setMod] = useState<CryptoModule | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  const [ids, setIds] = useState({ana: '', ben: '', mallory: ''});
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const [tamper, setTamper] = useState<Tamper>('none');
  const [room, setRoom] = useState<Room | null>(null);
  const [other, setOther] = useState<Room | null>(null);
  const [box, setBox] = useState('');
  const [wire, setWire] = useState('');
  const [result, setResult] = useState<{ok: boolean; payload: Record<string, unknown> | null} | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    import(/* webpackIgnore: true */ url)
      .then((m: CryptoModule) => {
        if (!live) return;
        setMod(m);
        setSecret(m.randomId(24));
        setIds({ana: m.randomId(16), ben: m.randomId(16), mallory: m.randomId(16)});
      })
      .catch((error: Error) => live && setLoadError(error.message));
    return () => {
      live = false;
    };
  }, [url]);

  useEffect(() => {
    if (!mod || !secret) return;
    let live = true;
    Promise.all([mod.deriveRoom(secret, APP), mod.deriveRoom(mod.randomId(24), APP)]).then(([r, o]) => {
      if (live) {
        setRoom(r);
        setOther(o);
      }
    });
    return () => {
      live = false;
    };
  }, [mod, secret]);

  useEffect(() => {
    if (!mod || !room || !other || !ids.ana) return;
    let live = true;
    (async () => {
      const sealed = await mod.seal(room, ids.ana, ids.ben, {kind: 'demo', n: 1, text: message});
      let delivered = sealed;
      if (tamper === 'flip') {
        const bytes = mod.fromBase64Url(sealed);
        const at = 12 + Math.floor((bytes.length - 12) / 2);
        bytes[at] ^= 0x01;
        delivered = mod.toBase64Url(bytes);
      }
      const from = tamper === 'relabel' ? ids.mallory : ids.ana;
      const opener = tamper === 'wrongkey' ? other : room;
      const payload = await mod.open(opener, from, ids.ben, delivered);
      if (!live) return;
      setBox(sealed);
      setWire(delivered);
      setResult({ok: !!payload, payload});
    })();
    return () => {
      live = false;
    };
  }, [mod, room, other, ids, message, tamper]);

  // Replay the envelope and the verdict stamp when the situation changes, not on every keystroke.
  useEffect(() => setRound((n) => n + 1), [tamper, secret]);

  const newSecret = useCallback(() => {
    if (!mod) return;
    setSecret(mod.randomId(24));
    setTamper('none');
  }, [mod]);

  const sendFrame = useMemo(() => (room && box ? JSON.stringify({t: 'send', room: room.tag, to: ids.ben, box}) : ''), [room, box, ids.ben]);
  const recvFrame = useMemo(
    () => (room && wire ? JSON.stringify({t: 'recv', room: room.tag, from: tamper === 'relabel' ? ids.mallory : ids.ana, box: wire}) : ''),
    [room, wire, tamper, ids],
  );
  const plainBytes = useMemo(() => new TextEncoder().encode(JSON.stringify({kind: 'demo', n: 1, text: message})).length, [message]);

  if (loadError) {
    return (
      <div className={d.card}>
        <div className={d.cardHead}>
          <p className={d.cardTitle}>What the gate sees</p>
        </div>
        <div className={d.cardBody}>
          <p>Freehop's crypto module could not be loaded ({loadError}). Run the site with npm start or npm run build so that static/lib is generated.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={clsx(d.card, s.gate)}>
      <div className={d.cardHead}>
        <p className={d.cardTitle}>What the gate sees</p>
        <button type="button" className={d.ghostButton} onClick={newSecret} disabled={!mod}>
          New room secret
        </button>
      </div>
      <div className={clsx(d.cardBody, s.body)}>
        <section className={s.col} aria-label="Ana's browser">
          <header className={s.colHead}>
            <span>Ana's browser</span>
            <span className={s.keyBadge}>
              <svg viewBox="-28 -14 56 28" width="34" height="18" aria-hidden="true">
                <Key scale={0.9} />
              </svg>
              has the secret
            </span>
          </header>
          <label className={s.label} htmlFor="fh-gate-message">
            Message to Ben
          </label>
          <textarea id="fh-gate-message" className={s.textarea} value={message} maxLength={400} rows={4} onChange={(e) => setMessage(e.target.value)} />
          <div className={s.meta}>
            <div>
              <span className={s.metaLabel}>Room secret</span>
              <code className={s.code}>{secret || '…'}</code>
            </div>
            <div>
              <span className={s.metaLabel}>Ana's peer id</span>
              <code className={s.code}>{ids.ana || '…'}</code>
            </div>
          </div>
          <p className={s.small}>
            Sealed in this page with Freehop's own <code>crypto.mjs</code>: HKDF-SHA256 derives the room tag and an AES-256-GCM key from the secret.
          </p>
        </section>

        <section className={clsx(s.col, s.middle)} aria-label="The gate">
          <header className={s.colHead}>
            <span>The gate</span>
            <span className={clsx(s.keyBadge, s.noKey)}>no key</span>
          </header>
          <div className={s.mailStage} aria-hidden="true">
            <svg viewBox="0 0 260 150" className={s.mailSvg}>
              <path d="M12 75h236" stroke="#657893" strokeDasharray="5 7" />
              <rect x="73" y="33" width="114" height="84" rx="5" fill="#202b40" stroke="#9fbcff" />
              <text x="130" y="71" textAnchor="middle" fill="#9fbcff" fontFamily="monospace" fontSize="14">
                SEALED
              </text>
              <text x="130" y="94" textAnchor="middle" fill="#bac5d8" fontFamily="monospace" fontSize="11">
                AES-256-GCM
              </text>
            </svg>
          </div>
          <p className={s.frameLabel}>Ana to gate</p>
          <pre className={s.frame}>
            <code>{sendFrame || '…'}</code>
          </pre>
          <p className={s.frameLabel}>Gate to Ben{tamper === 'relabel' ? ' (relabelled)' : tamper === 'flip' ? ' (one bit flipped)' : ''}</p>
          <pre className={clsx(s.frame, tamper !== 'none' && s.frameTampered)}>
            <code>{recvFrame ? <Diff prev={JSON.stringify({t: 'recv', room: room?.tag, from: ids.ana, box})} next={recvFrame} /> : '…'}</code>
          </pre>
          <p className={s.small}>
            The gate also sees connecting IP addresses. This frame reveals a room tag, peer ids, {sendFrame.length} bytes and the time. Your {plainBytes}-byte
            message is inside the box.
          </p>
          <div className={s.tampers} role="group" aria-label="Tamper with the envelope">
            {(Object.keys(TAMPER) as Exclude<Tamper, 'none'>[]).map((t) => (
              <button
                key={t}
                type="button"
                className={clsx(s.tamper, tamper === t && s.tamperOn)}
                aria-pressed={tamper === t}
                onClick={() => setTamper(tamper === t ? 'none' : t)}
              >
                {TAMPER[t].label}
              </button>
            ))}
          </div>
        </section>

        <section className={s.col} aria-label="Ben's browser">
          <header className={s.colHead}>
            <span>Ben's browser</span>
            <span className={s.keyBadge}>
              <svg viewBox="-28 -14 56 28" width="34" height="18" aria-hidden="true">
                <Key scale={0.9} fill={tamper === 'wrongkey' ? '#ffffff' : C.yellow} />
              </svg>
              {tamper === 'wrongkey' ? 'wrong secret' : 'has the secret'}
            </span>
          </header>
          <div aria-live="polite">
            {result && (
              <div key={`${round}-${result.ok}`} className={clsx(s.outcome, result.ok ? s.ok : s.bad, d.pop)}>
                <span className={s.stamp}>{result.ok ? 'Opened' : 'Rejected'}</span>
                {result.ok ? (
                  <>
                    <p className={s.outcomeText}>Authenticated with this room's shared key, addressed from Ana to Ben.</p>
                    <blockquote className={s.plain}>{String(result.payload?.text ?? '')}</blockquote>
                  </>
                ) : (
                  <p className={s.outcomeText}>{tamper !== 'none' ? TAMPER[tamper].explain : 'Authentication failed.'}</p>
                )}
              </div>
            )}
          </div>
          <details className={s.details}>
            <summary>How the envelope is sealed</summary>
            <pre className={s.recipe}>
              <code>
                {`salt = "peerlane/v1/${APP}"
tag  = base64url(HKDF-SHA256(secret, salt, "room-tag"))
key  = HKDF-SHA256(secret, salt, "envelope-key")  // AES-256-GCM
aad  = "peerlane/v1|" + tag + "|" + from + "|" + to
box  = base64url(iv[12] || AES-GCM(key, iv, plaintext, aad))`}
              </code>
            </pre>
            <p className={s.small}>
              Any room member holds this key and could claim another sender id. The envelope protects against outsiders, not impersonation by a member. Wire
              strings still say <code>peerlane</code>, Freehop's codename. The tag here is <code>{room ? short(room.tag) : '…'}</code>.
            </p>
          </details>
        </section>
      </div>
    </div>
  );
}
