import {useCallback, useEffect, useMemo, useRef, useState, type CSSProperties} from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';
import styles from './MazeGame.module.css';

type Position = {x: number; y: number};
type Emitter = {on(type: string, fn: (detail: any) => void): () => void};
type Quality = {peer: string; direction: 'send' | 'receive'; level: string; reason: string};
type Room = Emitter & {
  id: string;
  send(data: unknown, options?: {to?: string}): Promise<number>;
  setMicrophone(on: boolean): Promise<void>;
  setCamera(on: boolean): Promise<void>;
  setAdaptiveVideo(on: boolean): Promise<boolean>;
  leave(): Promise<void>;
};
type ClientModule = {join(options: Record<string, unknown>): Promise<Room>};
type RemotePlayer = Position & {id: string};
type MediaPeer = {id: string; stream: MediaStream};

const TRACKERS = ['bt+wss://tracker.openwebtorrent.com', 'bt+wss://tracker.webtorrent.dev'];
const STUN = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];
const APP = 'freehop-maze-demo';
const MAZE = [
  '###############',
  '#.....#.......#',
  '#.###.#.#####.#',
  '#...#.#.....#.#',
  '###.#.###.#.#.#',
  '#...#.....#...#',
  '#.#####.###.#.#',
  '#.............#',
  '###############',
];
const COLORS = ['#e86855', '#3376bd', '#168578', '#8e62a7'];
const STARTS = [{x: 1, y: 1}, {x: 13, y: 1}, {x: 1, y: 7}, {x: 11, y: 7}];
const GOAL = {x: 13, y: 7};

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function validPosition(value: unknown): value is Position {
  if (!value || typeof value !== 'object') return false;
  const {x, y} = value as Position;
  return Number.isInteger(x) && Number.isInteger(y) && y >= 0 && y < MAZE.length && x >= 0 && x < MAZE[y].length && MAZE[y][x] !== '#';
}

function MediaTile({peer}: {peer: MediaPeer}) {
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [, refresh] = useState(0);
  useEffect(() => {
    if (video.current) { video.current.srcObject = peer.stream; void video.current.play().catch(() => {}); }
    if (audio.current) {
      audio.current.srcObject = peer.stream;
      void audio.current.play().then(() => setSoundBlocked(false)).catch(() => setSoundBlocked(true));
    }
    const tracks = peer.stream.getVideoTracks();
    const bump = () => refresh(value => value + 1);
    for (const track of tracks) { track.addEventListener('mute', bump); track.addEventListener('unmute', bump); track.addEventListener('ended', bump); }
    return () => {
      if (video.current) video.current.srcObject = null;
      if (audio.current) audio.current.srcObject = null;
      for (const track of tracks) { track.removeEventListener('mute', bump); track.removeEventListener('unmute', bump); track.removeEventListener('ended', bump); }
    };
  }, [peer.stream]);
  const hasVideo = peer.stream.getVideoTracks().some(track => track.readyState === 'live' && !track.muted);
  const enableSound = () => { if (audio.current) void audio.current.play().then(() => setSoundBlocked(false)).catch(() => setSoundBlocked(true)); };
  return <div className={styles.mediaTile}>
    <video ref={video} autoPlay playsInline muted className={hasVideo ? '' : styles.hidden} />
    {!hasVideo && <span className={styles.avatar}>{peer.id.slice(0, 1).toUpperCase()}</span>}
    <span className={styles.peerLabel}>{peer.id.slice(0, 6)}</span>
    <audio ref={audio} autoPlay />
    {soundBlocked && <button type="button" className={styles.enableSound} onClick={enableSound}>Enable sound</button>}
  </div>;
}

/** Small networked maze; the Freehop controls and quality feedback are the demo's main feature. */
export default function MazeGame() {
  const url = useBaseUrl('/lib/client/peerlane.mjs');
  const [code, setCode] = useState('');
  const [room, setRoom] = useState<Room | null>(null);
  const roomRef = useRef<Room | null>(null);
  const [position, setPosition] = useState<Position>(STARTS[0]);
  const positionRef = useRef<Position>(STARTS[0]);
  const [players, setPlayers] = useState<Record<string, RemotePlayer>>({});
  const [media, setMedia] = useState<Record<string, MediaPeer>>({});
  const [quality, setQuality] = useState<Record<string, Quality>>({});
  const [mic, setMic] = useState(false);
  const [camera, setCamera] = useState(false);
  const [adaptive, setAdaptive] = useState(true);
  const [phase, setPhase] = useState<'idle' | 'joining' | 'live' | 'error'>('idle');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const hash = window.location.hash.slice(1);
    const value = /^[A-Za-z0-9_-]{20,30}$/.test(hash) ? hash : newCode();
    setCode(value);
    if (hash !== value) window.history.replaceState(null, '', `#${value}`);
    return () => { mounted.current = false; const current = roomRef.current; roomRef.current = null; void current?.leave(); };
  }, []);

  const invite = useMemo(() => typeof window === 'undefined' || !code ? '' : `${window.location.origin}${window.location.pathname}#${code}`, [code]);
  const broadcastPosition = useCallback((next: Position) => {
    positionRef.current = next;
    setPosition(next);
    void roomRef.current?.send({type: 'maze-position', ...next}).catch(() => {});
  }, []);

  const join = useCallback(async () => {
    if (!code || roomRef.current) return;
    setPhase('joining'); setNotice('');
    try {
      const mod: ClientModule = await import(/* webpackIgnore: true */ url);
      const current = await mod.join({gates: TRACKERS, stun: STUN, secret: code, app: APP,
        media: {audio: false, video: false}, adaptiveVideo: true});
      if (!mounted.current) { await current.leave(); return; }
      roomRef.current = current; setRoom(current); setPhase('live');
      const start = STARTS[Array.from(current.id).reduce((sum, char) => sum + char.charCodeAt(0), 0) % STARTS.length];
      broadcastPosition(start);
      current.on('peer', ({id}) => { void current.send({type: 'maze-position', ...positionRef.current}, {to: id}).catch(() => {}); });
      current.on('message', ({from, data}) => {
        if (data?.type === 'maze-position' && validPosition(data)) setPlayers(previous => ({...previous, [from]: {id: from, x: data.x, y: data.y}}));
      });
      current.on('peer-left', ({id}) => {
        setPlayers(previous => { const next = {...previous}; delete next[id]; return next; });
        setMedia(previous => { const next = {...previous}; delete next[id]; return next; });
        setQuality(previous => Object.fromEntries(Object.entries(previous).filter(([, item]) => item.peer !== id)));
      });
      current.on('track', ({peer, track}) => setMedia(previous => {
        const stream = new MediaStream([...(previous[peer]?.stream.getTracks() ?? []).filter(item => item.kind !== track.kind), track]);
        return {...previous, [peer]: {id: peer, stream}};
      }));
      current.on('video-quality', (event: Quality) => setQuality(previous => ({...previous, [`${event.peer}-${event.direction}`]: event})));
    } catch (error) {
      if (!mounted.current) return;
      setPhase('error'); setNotice(`Could not join the game call: ${(error as Error).message}`);
    }
  }, [broadcastPosition, code, url]);

  useEffect(() => {
    if (!room) return;
    const onKey = (event: KeyboardEvent) => {
      const moves: Record<string, Position> = {ArrowUp: {x: 0, y: -1}, w: {x: 0, y: -1}, ArrowDown: {x: 0, y: 1}, s: {x: 0, y: 1},
        ArrowLeft: {x: -1, y: 0}, a: {x: -1, y: 0}, ArrowRight: {x: 1, y: 0}, d: {x: 1, y: 0}};
      const move = moves[event.key] ?? moves[event.key.toLowerCase()];
      if (!move || event.target instanceof HTMLElement && ['INPUT', 'BUTTON', 'TEXTAREA'].includes(event.target.tagName)) return;
      event.preventDefault();
      const next = {x: position.x + move.x, y: position.y + move.y};
      if (validPosition(next)) broadcastPosition(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [broadcastPosition, position, room]);

  const toggleMic = async () => {
    if (!room) return;
    try { await room.setMicrophone(!mic); setMic(!mic); setNotice(''); }
    catch (error) { setNotice(`Microphone could not start: ${(error as Error).message}`); }
  };
  const toggleCamera = async () => {
    if (!room) return;
    try { await room.setCamera(!camera); setCamera(!camera); setNotice(''); }
    catch (error) { setNotice(`Camera could not start: ${(error as Error).message}`); }
  };
  const toggleAdaptive = async () => {
    if (!room) return;
    const next = !adaptive;
    await room.setAdaptiveVideo(next);
    setAdaptive(next);
  };
  const copyInvite = async () => {
    try { await navigator.clipboard.writeText(invite); setNotice('Invite link copied.'); }
    catch { setNotice('Copy the room link from your browser address bar.'); }
  };
  const leave = async () => {
    const current = roomRef.current; roomRef.current = null; setRoom(null); setPhase('idle'); setMic(false); setCamera(false);
    setPlayers({}); setMedia({}); setQuality({}); await current?.leave();
  };

  const allPlayers = [{id: room?.id ?? 'you', ...position}, ...Object.values(players)];
  return <div className={styles.layout}>
    <section className={styles.gamePanel} aria-label="Shared maze">
      <div className={styles.gameTop}>
        <div><span className={styles.eyebrow}>A tiny game, a real call</span><h2>Find the exit together.</h2></div>
        <span className={styles.room}>room <code>{code.slice(0, 8) || '…'}</code></span>
      </div>
      <div className={styles.board} role="grid" aria-label="Maze. Use arrow keys or WASD to move.">
        {MAZE.flatMap((row, y) => [...row].map((cell, x) => {
          const occupants = allPlayers.filter(player => player.x === x && player.y === y);
          const goal = x === GOAL.x && y === GOAL.y;
          return <div key={`${x}-${y}`} role="gridcell" className={`${styles.cell} ${cell === '#' ? styles.wall : ''} ${goal ? styles.goal : ''}`}>
            {occupants.map((player, index) => <span key={player.id} className={styles.player} style={{'--player-color': COLORS[index % COLORS.length]} as CSSProperties} title={player.id === room?.id ? 'You' : player.id.slice(0, 6)} />)}
            {goal && <span className={styles.exitMark}>EXIT</span>}
          </div>;
        }))}
      </div>
      <div className={styles.gameBottom}><span>{Object.keys(players).length + (room ? 1 : 0)} in the maze</span><span>Move with ↑ ↓ ← → or WASD</span></div>
      {position.x === GOAL.x && position.y === GOAL.y && <p className={styles.won} role="status">You found the exit. Wait for your friends or start exploring again.</p>}
    </section>

    <aside className={styles.callPanel} aria-label="Freehop call controls">
      <div className={styles.callHead}><span className={styles.eyebrow}>Freehop SDK</span><h2>Talk while you play.</h2><p>Voice, video and adaptive quality sit inside the game.</p></div>
      {!room ? <div className={styles.joinArea}>
        <p>Join the room to share your position. Turn your microphone or camera on whenever you want.</p>
        <button type="button" className={styles.primary} onClick={() => void join()} disabled={phase === 'joining'}>{phase === 'joining' ? 'Joining…' : 'Join game room'}</button>
        {phase === 'error' && <p role="alert" className={styles.notice}>{notice}</p>}
        <button type="button" className={styles.copy} onClick={() => void copyInvite()}>Copy room invite</button>
      </div> : <>
        <div className={styles.controls}>
          <button type="button" aria-pressed={mic} onClick={() => void toggleMic()}>{mic ? 'Mute mic' : 'Turn mic on'}</button>
          <button type="button" aria-pressed={camera} onClick={() => void toggleCamera()}>{camera ? 'Camera off' : 'Turn camera on'}</button>
          <button type="button" aria-pressed={adaptive} onClick={() => void toggleAdaptive()}>{adaptive ? 'Adaptive on' : 'Adaptive off'}</button>
        </div>
        <div className={styles.quality} aria-live="polite">
          <strong>Video quality</strong>
          {Object.values(quality).length ? Object.values(quality).map(item => <span key={`${item.peer}-${item.direction}`}>{item.peer.slice(0, 6)} · {item.direction} · {item.level.replace('-', ' ')}{item.reason !== 'monitoring' && item.reason !== 'recovery' ? ` · ${item.reason.replace('-', ' ')}` : ''}</span>) : <span>Waiting for a peer</span>}
        </div>
        <div className={styles.people}>
          {Object.values(media).map(peer => <MediaTile key={peer.id} peer={peer} />)}
          {!Object.keys(media).length && <p className={styles.waiting}>Share the invite link to bring someone into the call.</p>}
        </div>
        <div className={styles.callActions}><button type="button" className={styles.copy} onClick={() => void copyInvite()}>Copy invite</button><button type="button" className={styles.leave} onClick={() => void leave()}>Leave call</button></div>
        {!!notice && <p className={styles.notice} role="status">{notice}</p>}
      </>}
      <p className={styles.foot}>A public tracker introduces the browsers. Audio and video travel between participants.</p>
    </aside>
  </div>;
}
