import {useCallback, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import clsx from 'clsx';
import useBaseUrl from '@docusaurus/useBaseUrl';
import PathBadge, {type PathKind} from '../PathBadge';
import s from './LiveCall.module.css';

// The real Freehop browser client, copied from ../src/client into static/lib at build time.
type Emitter = {on(type: string, fn: (detail: any) => void): () => void};
type FreehopRoom = Emitter & {
  id: string;
  tag: string;
  localStream: MediaStream | null;
  setMicrophone(on: boolean): Promise<void>;
  setCamera(on: boolean): Promise<void>;
  leave(): Promise<void>;
  stats(): Promise<{
    gates: {url: string; state: string; bytesIn: number; bytesOut: number}[];
    links: {peer: string; connected: boolean; path: {kind: string; via?: string | null}; media: {inbound: Record<string, {packets: number; bytes: number; frames: number}>}}[];
  }>;
};
type ClientModule = {join(options: Record<string, unknown>): Promise<FreehopRoom>};

export const TRACKERS = ['bt+wss://tracker.openwebtorrent.com', 'bt+wss://tracker.webtorrent.dev'];
const STUN = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];
const APP = 'freehop-demo';
const CODE = /^[A-Za-z0-9_-]{16,64}$/;

type Peer = {id: string; path: PathKind; via: string | null; audio: number; video: number};
type Phase = 'idle' | 'joining' | 'live' | 'left' | 'error';

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function codeFromHash() {
  const raw = decodeURIComponent(window.location.hash.replace(/^#/, ''));
  return CODE.test(raw) ? raw : null;
}

function kb(bytes: number) {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(bytes / 1000))} KB`;
}

function MediaTile({stream, label, muted, mirrored, children}: {stream: MediaStream | null; label: string; muted?: boolean; mirrored?: boolean; children?: ReactNode}) {
  const video = useRef<HTMLVideoElement>(null);
  const [, repaint] = useState(0);
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    el.srcObject = stream;
    if (stream) el.play().catch(() => {});
    // A remote camera that is switched off keeps its track but stops sending: show the placeholder.
    const tracks = stream?.getVideoTracks() ?? [];
    const bump = () => repaint(n => n + 1);
    for (const t of tracks) {
      t.addEventListener('mute', bump);
      t.addEventListener('unmute', bump);
      t.addEventListener('ended', bump);
    }
    return () => {
      for (const t of tracks) {
        t.removeEventListener('mute', bump);
        t.removeEventListener('unmute', bump);
        t.removeEventListener('ended', bump);
      }
    };
  }, [stream]);
  const hasVideo = !!stream?.getVideoTracks().some(t => t.readyState === 'live' && t.enabled && !t.muted);
  return (
    <figure className={s.tile}>
      <div className={s.screen}>
        <video ref={video} autoPlay playsInline muted={muted} className={clsx(s.video, mirrored && s.mirrored, !hasVideo && s.hidden)} />
        {!hasVideo && (
          <div className={s.placeholder} aria-hidden="true">
            <span>{label.slice(0, 1).toUpperCase()}</span>
          </div>
        )}
      </div>
      <figcaption className={s.caption}>
        <span className={s.name}>{label}</span>
        {children}
      </figcaption>
    </figure>
  );
}

function RemoteTile({peer, streams}: {peer: Peer; streams: MediaStream | undefined}) {
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = audio.current;
    if (!el || !streams) return;
    const tracks = streams.getAudioTracks();
    el.srcObject = tracks.length ? new MediaStream(tracks) : null;
    el.play().catch(() => {});
  }, [streams]);
  return (
    <MediaTile stream={streams ?? null} label={`Peer ${peer.id.slice(0, 6)}`}>
      <PathBadge kind={peer.path} via={peer.via ? peer.via.slice(0, 6) : undefined} size="sm" />
      <span className={s.counters}>
        audio {peer.audio.toLocaleString('en-US')} pkts · video {peer.video.toLocaleString('en-US')} frames
      </span>
      <audio ref={audio} autoPlay />
    </MediaTile>
  );
}

/** A real Freehop call in the visitor's browser, with public WebTorrent trackers as the only gates. */
export default function LiveCall() {
  const url = useBaseUrl('/lib/client/peerlane.mjs');
  const [code, setCode] = useState<string>('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [room, setRoom] = useState<FreehopRoom | null>(null);
  const [peers, setPeers] = useState<Record<string, Peer>>({});
  const [streams, setStreams] = useState<Record<string, MediaStream>>({});
  const [gates, setGates] = useState<Record<string, string>>(() => Object.fromEntries(TRACKERS.map(t => [t, 'idle'])));
  const [traffic, setTraffic] = useState({signal: 0, media: 0});
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);
  const [withVideo, setWithVideo] = useState(true);
  const [copied, setCopied] = useState(false);
  const [lonely, setLonely] = useState(false);
  const roomRef = useRef<FreehopRoom | null>(null);

  // Room code lives in the URL fragment, which never reaches any server.
  useEffect(() => {
    let current = codeFromHash();
    if (!current) {
      current = newCode();
      window.history.replaceState(null, '', `#${current}`);
    }
    setCode(current);
    const onHash = () => {
      const next = codeFromHash();
      if (next && !roomRef.current) setCode(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const invite = useMemo(() => (typeof window === 'undefined' || !code ? '' : `${window.location.origin}${window.location.pathname}#${code}`), [code]);

  const join = useCallback(
    async (video: boolean) => {
      if (roomRef.current || !code) return;
      setError(null);
      setPhase('joining');
      setWithVideo(video);
      setGates(Object.fromEntries(TRACKERS.map(t => [t, 'connecting'])));
      try {
        const mod: ClientModule = await import(/* webpackIgnore: true */ url);
        const r = await mod.join({gates: TRACKERS, stun: STUN, secret: code, app: APP, media: {audio: true, video}});
        roomRef.current = r;
        setRoom(r);
        setMic(true);
        setCam(video);
        r.on('gate', ({url: gate, state}) => setGates(g => ({...g, [gate]: state})));
        r.on('peer', ({id}) => setPeers(p => ({...p, [id]: p[id] ?? {id, path: 'connecting', via: null, audio: 0, video: 0}})));
        r.on('peer-left', ({id}) => {
          setPeers(p => {
            const next = {...p};
            delete next[id];
            return next;
          });
          setStreams(st => {
            const next = {...st};
            delete next[id];
            return next;
          });
        });
        r.on('path', ({peer, kind, via}) =>
          setPeers(p => ({...p, [peer]: {...(p[peer] ?? {id: peer, audio: 0, video: 0}), path: kind as PathKind, via: via ?? null}})),
        );
        r.on('track', ({peer, track}) => {
          setStreams(st => {
            const stream = new MediaStream([...(st[peer]?.getTracks() ?? []).filter(t => t.kind !== track.kind || t.readyState === 'live'), track]);
            return {...st, [peer]: stream};
          });
          track.addEventListener('ended', () => setStreams(st => ({...st})));
        });
        setPhase('live');
      } catch (e) {
        const err = e as Error & {name?: string};
        roomRef.current = null;
        setRoom(null);
        setPhase('error');
        setError(
          err.name === 'NotAllowedError'
            ? 'Camera or microphone access was blocked. Allow it for this page in your browser, then join again.'
            : err.name === 'NotFoundError'
              ? 'No camera or microphone was found. Try joining with the microphone only.'
              : `Could not join: ${err.message}`,
        );
      }
    },
    [code, url],
  );

  // Live counters: tracker (signalling) bytes versus media bytes received, plus per-peer packets.
  useEffect(() => {
    if (!room) return;
    let live = true;
    const started = Date.now();
    const tick = async () => {
      try {
        const st = await room.stats();
        if (!live) return;
        const signal = st.gates.reduce((sum, g) => sum + (g.bytesIn ?? 0) + (g.bytesOut ?? 0), 0);
        let media = 0;
        const counts: Record<string, {audio: number; video: number}> = {};
        for (const link of st.links) {
          const inbound = link.media.inbound;
          media += Object.values(inbound).reduce((sum, m) => sum + (m.bytes ?? 0), 0);
          counts[link.peer] = {audio: inbound.audio?.packets ?? 0, video: inbound.video?.frames ?? 0};
        }
        setTraffic({signal, media});
        setPeers(p => {
          const next = {...p};
          for (const [id, c] of Object.entries(counts)) if (next[id]) next[id] = {...next[id], ...c};
          return next;
        });
        setLonely(st.links.length === 0 && Date.now() - started > 30000);
      } catch {
        /* the room may be closing */
      }
    };
    const timer = window.setInterval(tick, 1500);
    tick();
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [room]);

  // A debugging handle for automated checks of the demo itself.
  useEffect(() => {
    (window as any).freehopDemo = {phase, peers, gates, traffic, id: room?.id ?? null, stats: () => roomRef.current?.stats()};
  }, [phase, peers, gates, traffic, room]);

  const leave = useCallback(async () => {
    const r = roomRef.current;
    roomRef.current = null;
    setRoom(null);
    setPeers({});
    setStreams({});
    setLonely(false);
    setPhase('left');
    setGates(Object.fromEntries(TRACKERS.map(t => [t, 'idle'])));
    await r?.leave();
  }, []);

  useEffect(() => () => void roomRef.current?.leave(), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invite);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  const fresh = () => {
    if (roomRef.current) return;
    const next = newCode();
    window.history.replaceState(null, '', `#${next}`);
    setCode(next);
  };

  const toggleMic = async () => {
    if (!room) return;
    await room.setMicrophone(!mic);
    setMic(!mic);
  };
  const toggleCam = async () => {
    if (!room) return;
    try {
      await room.setCamera(!cam);
      setCam(!cam);
    } catch (e) {
      setError(`Camera: ${(e as Error).message}`);
    }
  };

  const peerList = Object.values(peers);
  const trackerStates = TRACKERS.map(t => ({url: t, short: t.replace('bt+wss://', ''), state: gates[t] ?? 'idle'}));
  const anyTracker = trackerStates.some(t => t.state === 'joined');

  return (
    <div className={s.call}>
      <section className={s.panel} aria-label="Room">
        <div className={s.roomRow}>
          <div className={s.roomCode}>
            <span className={s.label}>Room code</span>
            <code className={s.code}>{code || '…'}</code>
          </div>
          <div className={s.roomButtons}>
            <button type="button" className={s.ghost} onClick={copy} disabled={!invite}>
              {copied ? 'Invite link copied' : 'Copy invite link'}
            </button>
            <button type="button" className={s.ghost} onClick={fresh} disabled={!!room}>
              New room
            </button>
          </div>
        </div>
        <ul className={s.trackers} aria-label="Gates">
          {trackerStates.map(t => (
            <li key={t.url} className={clsx(s.tracker, s[`t_${t.state}`])}>
              <span className={s.trackerDot} aria-hidden="true" />
              <span className={s.trackerName}>{t.short}</span>
              <span className={s.trackerState}>{t.state === 'idle' ? 'not connected' : t.state}</span>
            </li>
          ))}
        </ul>
      </section>

      {phase !== 'live' && phase !== 'joining' && (
        <div className={s.joinBox}>
          <p className={s.joinText}>
            Camera and microphone start only when you press join. Open the invite link in another tab, on another device, or send it
            to a friend.
          </p>
          <div className={s.joinButtons}>
            <button type="button" className={s.primary} onClick={() => join(true)} disabled={!code}>
              Join with camera and microphone <span aria-hidden="true">&gt;</span>
            </button>
            <button type="button" className={s.secondary} onClick={() => join(false)} disabled={!code}>
              Microphone only
            </button>
          </div>
          {phase === 'left' && <p className={s.notice}>You left the call. Join again whenever you like.</p>}
        </div>
      )}

      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}

      {(phase === 'joining' || phase === 'live') && (
        <>
          <div className={s.controls}>
            <button type="button" className={clsx(s.control, !mic && s.controlOff)} onClick={toggleMic} disabled={!room} aria-pressed={!mic}>
              {mic ? 'Mute microphone' : 'Unmute microphone'}
            </button>
            {withVideo && (
              <button type="button" className={clsx(s.control, !cam && s.controlOff)} onClick={toggleCam} disabled={!room} aria-pressed={!cam}>
                {cam ? 'Turn camera off' : 'Turn camera on'}
              </button>
            )}
            <button type="button" className={clsx(s.control, s.leave)} onClick={leave}>
              Leave
            </button>
            <span className={s.you}>{room ? `You are ${room.id.slice(0, 6)}` : 'Joining…'}</span>
          </div>

          <div className={s.meters} aria-live="polite">
            <div className={s.meter}>
              <span className={s.meterLabel}>Through the trackers (signalling)</span>
              <span className={s.meterValue}>{kb(traffic.signal)}</span>
            </div>
            <div className={s.meter}>
              <span className={s.meterLabel}>Media received from peers</span>
              <span className={s.meterValue}>{kb(traffic.media)}</span>
            </div>
            <div className={s.meter}>
              <span className={s.meterLabel}>People connected</span>
              <span className={s.meterValue}>{peerList.length}</span>
            </div>
          </div>

          <div className={s.grid}>
            {peerList.map(peer => (
              <RemoteTile key={peer.id} peer={peer} streams={streams[peer.id]} />
            ))}
            {peerList.length === 0 && (
              <div className={s.waiting}>
                <p className={s.waitingTitle}>{anyTracker ? 'Waiting for someone to join' : 'Reaching the public trackers'}</p>
                <p className={s.waitingText}>
                  {lonely
                    ? 'Nobody has appeared yet. Check that the other side uses the same invite link. If the trackers stay unreachable from your network, peers cannot find each other.'
                    : 'Share the invite link. Peers find each other through the trackers, then talk directly.'}
                </p>
              </div>
            )}
            <MediaTile stream={room?.localStream ?? null} label="You" muted mirrored>
              <span className={s.counters}>{mic ? 'microphone on' : 'muted'}</span>
            </MediaTile>
          </div>
        </>
      )}
    </div>
  );
}
