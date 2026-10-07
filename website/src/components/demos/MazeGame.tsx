import {useCallback, useEffect, useMemo, useRef, useState, type CSSProperties} from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';
import styles from './MazeGame.module.css';
import WorldView from '../world/WorldView';

type Position = {x: number; y: number};
type Emitter = {on(type: string, fn: (detail: any) => void): () => void};
type Quality = {peer: string; direction: 'send' | 'receive'; level: string; reason: string};
type Room = Emitter & {
  id: string;
  localStream?: MediaStream;
  send(data: unknown, options?: {to?: string}): Promise<number>;
  setMicrophone(on: boolean): Promise<void>;
  setCamera(on: boolean): Promise<void>;
  setAdaptiveVideo(on: boolean): Promise<boolean>;
  leave(): Promise<void>;
};
type ClientModule = {join(options: Record<string, unknown>): Promise<Room>};
type RemotePlayer = Position & {id: string};
type MediaPeer = {id: string; stream: MediaStream; local?: boolean};

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
const ARENA = ['###############', ...Array(7).fill('#.............#'), '###############'];
const BEACONS = [
  {x: 7, y: 4},
  {x: 12, y: 2},
  {x: 3, y: 6},
  {x: 10, y: 6},
  {x: 2, y: 2},
];
const COLORS = ['#e86855', '#3376bd', '#168578', '#8e62a7'];
const STARTS = [
  {x: 1, y: 1},
  {x: 13, y: 1},
  {x: 1, y: 7},
  {x: 11, y: 7},
];
const GOAL = {x: 13, y: 7};

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function validPosition(value: unknown, board = MAZE): value is Position {
  if (!value || typeof value !== 'object') return false;
  const {x, y} = value as Position;
  return Number.isInteger(x) && Number.isInteger(y) && y >= 0 && y < board.length && x >= 0 && x < board[y].length && board[y][x] !== '#';
}

function MediaTile({peer}: {peer: MediaPeer}) {
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [, refresh] = useState(0);
  useEffect(() => {
    if (video.current) {
      video.current.srcObject = peer.stream;
      void video.current.play().catch(() => {});
    }
    if (audio.current && !peer.local) {
      audio.current.srcObject = peer.stream;
      void audio.current
        .play()
        .then(() => setSoundBlocked(false))
        .catch(() => setSoundBlocked(true));
    }
    const tracks = peer.stream.getVideoTracks();
    const bump = () => refresh((value) => value + 1);
    for (const track of tracks) {
      track.addEventListener('mute', bump);
      track.addEventListener('unmute', bump);
      track.addEventListener('ended', bump);
    }
    return () => {
      if (video.current) video.current.srcObject = null;
      if (audio.current) audio.current.srcObject = null;
      for (const track of tracks) {
        track.removeEventListener('mute', bump);
        track.removeEventListener('unmute', bump);
        track.removeEventListener('ended', bump);
      }
    };
  }, [peer.local, peer.stream]);
  const hasVideo = peer.stream.getVideoTracks().some((track) => track.readyState === 'live' && !track.muted);
  const enableSound = () => {
    if (audio.current)
      void audio.current
        .play()
        .then(() => setSoundBlocked(false))
        .catch(() => setSoundBlocked(true));
  };
  return (
    <div className={styles.mediaTile}>
      <video ref={video} autoPlay playsInline muted className={hasVideo ? '' : styles.hidden} />
      {!hasVideo && <span className={styles.avatar}>{peer.local ? 'You' : peer.id.slice(0, 1).toUpperCase()}</span>}
      <span className={styles.peerLabel}>{peer.local ? 'You' : peer.id.slice(0, 6)}</span>
      <span className={styles.cameraStatus}>{hasVideo ? 'Video on' : 'Camera off'}</span>
      {!peer.local && <audio ref={audio} autoPlay />}
      {soundBlocked && (
        <button type="button" className={styles.enableSound} onClick={enableSound}>
          Enable sound
        </button>
      )}
    </div>
  );
}

/** Small networked maze; the Freehop controls and quality feedback are the demo's main feature. */
export default function MazeGame({mode = 'maze'}: {mode?: 'maze' | 'orbital'}) {
  const board = mode === 'orbital' ? ARENA : MAZE;
  const [mapView, setMapView] = useState(false);
  const [score, setScore] = useState(0);
  const goal = mode === 'orbital' ? BEACONS[score % BEACONS.length] : GOAL;
  const url = useBaseUrl('/lib/client/peerlane.mjs');
  const [code, setCode] = useState('');
  const [room, setRoom] = useState<Room | null>(null);
  const roomRef = useRef<Room | null>(null);
  const [position, setPosition] = useState<Position>(STARTS[0]);
  const positionRef = useRef<Position>(STARTS[0]);
  const positionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPositionSent = useRef(0);
  const [players, setPlayers] = useState<Record<string, RemotePlayer>>({});
  const [media, setMedia] = useState<Record<string, MediaPeer>>({});
  const [localMedia, setLocalMedia] = useState<MediaPeer | null>(null);
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
    return () => {
      mounted.current = false;
      if (positionTimer.current !== null) clearTimeout(positionTimer.current);
      positionTimer.current = null;
      const current = roomRef.current;
      roomRef.current = null;
      void current?.leave();
    };
  }, []);

  const invite = useMemo(() => (typeof window === 'undefined' || !code ? '' : `${window.location.origin}${window.location.pathname}#${code}`), [code]);
  const broadcastPosition = useCallback((next: Position) => {
    positionRef.current = next;
    setPosition(next);
    // Coalesce fast input into at most 12.5 updates/s, below the receiver's 20/s limit.
    if (!roomRef.current || positionTimer.current !== null) return;
    const flush = () => {
      positionTimer.current = null;
      lastPositionSent.current = performance.now();
      void roomRef.current?.send({type: 'maze-position', ...positionRef.current}).catch(() => {});
    };
    const wait = Math.max(0, 80 - (performance.now() - lastPositionSent.current));
    if (wait === 0) flush();
    else positionTimer.current = setTimeout(flush, wait);
  }, []);

  const join = useCallback(async () => {
    if (!code || roomRef.current) return;
    setPhase('joining');
    setNotice('');
    try {
      const mod: ClientModule = await import(/* webpackIgnore: true */ url);
      const current = await mod.join({
        gates: TRACKERS,
        stun: STUN,
        secret: code,
        app: `${APP}-${mode}`,
        media: {audio: false, video: false},
        adaptiveVideo: true,
      });
      if (!mounted.current) {
        await current.leave();
        return;
      }
      roomRef.current = current;
      setRoom(current);
      setPhase('live');
      setLocalMedia({id: current.id, local: true, stream: new MediaStream(current.localStream?.getTracks() ?? [])});
      const start = STARTS[Array.from(current.id).reduce((sum, char) => sum + char.charCodeAt(0), 0) % STARTS.length];
      broadcastPosition(start);
      current.on('peer', ({id}) => {
        setMedia((previous) => (previous[id] ? previous : {...previous, [id]: {id, stream: new MediaStream()}}));
        void current.send({type: 'maze-position', ...positionRef.current}, {to: id}).catch(() => {});
      });
      current.on('message', ({from, data}) => {
        if (data?.type === 'maze-position' && validPosition(data, board)) setPlayers((previous) => ({...previous, [from]: {id: from, x: data.x, y: data.y}}));
      });
      current.on('peer-left', ({id}) => {
        setPlayers((previous) => {
          const next = {...previous};
          delete next[id];
          return next;
        });
        setMedia((previous) => {
          const next = {...previous};
          delete next[id];
          return next;
        });
        setQuality((previous) => Object.fromEntries(Object.entries(previous).filter(([, item]) => item.peer !== id)));
      });
      current.on('track', ({peer, track}) =>
        setMedia((previous) => {
          const stream = new MediaStream([...(previous[peer]?.stream.getTracks() ?? []).filter((item) => item.kind !== track.kind), track]);
          return {...previous, [peer]: {id: peer, stream}};
        }),
      );
      current.on('video-quality', (event: Quality) => setQuality((previous) => ({...previous, [`${event.peer}-${event.direction}`]: event})));
    } catch (error) {
      if (!mounted.current) return;
      setPhase('error');
      setNotice(`Could not join the game call: ${(error as Error).message}`);
    }
  }, [broadcastPosition, code, url, mode, board]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || (event.target instanceof HTMLElement && event.target.isContentEditable)) return;
      const moves: Record<string, Position> = {
        ArrowUp: {x: 0, y: -1},
        w: {x: 0, y: -1},
        ArrowDown: {x: 0, y: 1},
        s: {x: 0, y: 1},
        ArrowLeft: {x: -1, y: 0},
        a: {x: -1, y: 0},
        ArrowRight: {x: 1, y: 0},
        d: {x: 1, y: 0},
      };
      const move = moves[event.key] ?? moves[event.key.toLowerCase()];
      if (!move || (event.target instanceof HTMLElement && ['INPUT', 'BUTTON', 'TEXTAREA'].includes(event.target.tagName))) return;
      event.preventDefault();
      const next = {x: positionRef.current.x + move.x, y: positionRef.current.y + move.y};
      if (validPosition(next, board)) broadcastPosition(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [broadcastPosition, position, room, board]);

  const toggleMic = async () => {
    if (!room) return;
    try {
      await room.setMicrophone(!mic);
      setMic(!mic);
      setNotice('');
    } catch (error) {
      setNotice(`Microphone could not start: ${(error as Error).message}`);
    }
  };
  const toggleCamera = async () => {
    if (!room) return;
    try {
      await room.setCamera(!camera);
      setCamera(!camera);
      setLocalMedia({id: room.id, local: true, stream: new MediaStream(room.localStream?.getTracks() ?? [])});
      setNotice('');
    } catch (error) {
      setNotice(`Camera could not start: ${(error as Error).message}`);
    }
  };
  const toggleAdaptive = async () => {
    if (!room) return;
    const next = !adaptive;
    try {
      await room.setAdaptiveVideo(next);
      setAdaptive(next);
    } catch (error) {
      setNotice(`Could not change adaptive video: ${(error as Error).message}`);
    }
  };
  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(invite);
      setNotice('Invite link copied.');
    } catch {
      setNotice('Copy the room link from your browser address bar.');
    }
  };
  const leave = async () => {
    if (positionTimer.current !== null) clearTimeout(positionTimer.current);
    positionTimer.current = null;
    const current = roomRef.current;
    roomRef.current = null;
    setRoom(null);
    setPhase('idle');
    setMic(false);
    setCamera(false);
    setPlayers({});
    setMedia({});
    setLocalMedia(null);
    setQuality({});
    await current?.leave();
  };

  useEffect(() => {
    if (mode === 'orbital' && position.x === goal.x && position.y === goal.y) setScore((n) => n + 1);
  }, [position, goal, mode]);
  const move = (dx: number, dy: number) => {
    const next = {x: positionRef.current.x + dx, y: positionRef.current.y + dy};
    if (validPosition(next, board)) broadcastPosition(next);
  };
  const allPlayers = [{id: room?.id ?? 'you', ...position}, ...Object.values(players)];
  return (
    <div className={styles.layout}>
      <section className={styles.gamePanel} aria-label="Shared maze">
        <div className={styles.gameTop}>
          <div>
            <span className={styles.eyebrow}>THREE.JS × FREEHOP</span>
            <h2>{mode === 'orbital' ? 'Orbital' : 'Signal Run'}</h2>
          </div>
          <span className={styles.room}>
            room <code>{code.slice(0, 8) || '…'}</code>
          </span>
        </div>
        <div className={styles.viewControls}>
          <button type="button" onClick={() => setMapView((v) => !v)}>
            {mapView ? 'Switch to 3D' : 'Switch to map'}
          </button>
          <span>{mode === 'orbital' ? `Beacons collected: ${score}` : 'Find the signal at the exit'}</span>
        </div>
        {!mapView && <WorldView walls={board} players={allPlayers} goal={goal} orbital={mode === 'orbital'} />}
        {mapView && (
          <div className={styles.board} role="grid" aria-label="Maze. Use arrow keys or WASD to move.">
            {board.flatMap((row, y) =>
              [...row].map((cell, x) => {
                const occupants = allPlayers.filter((player) => player.x === x && player.y === y);
                const isGoal = x === goal.x && y === goal.y;
                return (
                  <div key={`${x}-${y}`} role="gridcell" className={`${styles.cell} ${cell === '#' ? styles.wall : ''} ${isGoal ? styles.goal : ''}`}>
                    {occupants.map((player, index) => (
                      <span
                        key={player.id}
                        className={styles.player}
                        style={{'--player-color': COLORS[index % COLORS.length]} as CSSProperties}
                        title={player.id === room?.id ? 'You' : player.id.slice(0, 6)}
                      />
                    ))}
                    {isGoal && <span className={styles.exitMark}>EXIT</span>}
                  </div>
                );
              }),
            )}
          </div>
        )}
        <div className={styles.dpad} aria-label="Movement controls">
          <button type="button" aria-label="Move left" onClick={() => move(-1, 0)}>
            ←
          </button>
          <button type="button" aria-label="Move up" onClick={() => move(0, -1)}>
            ↑
          </button>
          <button type="button" aria-label="Move down" onClick={() => move(0, 1)}>
            ↓
          </button>
          <button type="button" aria-label="Move right" onClick={() => move(1, 0)}>
            →
          </button>
        </div>
        <div className={styles.gameBottom}>
          <span>{Object.keys(players).length + (room ? 1 : 0)} connected</span>
          <span>Move with ↑ ↓ ← → or WASD</span>
        </div>
        {mode === 'maze' && position.x === GOAL.x && position.y === GOAL.y && (
          <p className={styles.won} role="status">
            You found the exit. Wait for your friends or start exploring again.
          </p>
        )}
      </section>

      <aside className={styles.callPanel} aria-label="Freehop call controls">
        <div className={styles.callHead}>
          <span className={styles.eyebrow}>Freehop SDK</span>
          <h2>Talk while you play.</h2>
          <p>Voice, video and adaptive quality sit inside the game.</p>
        </div>
        {!room ? (
          <div className={styles.joinArea}>
            <p>Join the room to share your position. Turn your microphone or camera on whenever you want.</p>
            <button type="button" className={styles.primary} onClick={() => void join()} disabled={phase === 'joining'}>
              {phase === 'joining' ? 'Joining…' : 'Join game room'}
            </button>
            {phase === 'error' && (
              <p role="alert" className={styles.notice}>
                {notice}
              </p>
            )}
            <button type="button" className={styles.copy} onClick={() => void copyInvite()}>
              Copy room invite
            </button>
          </div>
        ) : (
          <>
            <div className={styles.controls}>
              <button type="button" aria-pressed={mic} onClick={() => void toggleMic()}>
                {mic ? 'Mute mic' : 'Turn mic on'}
              </button>
              <button type="button" aria-pressed={camera} onClick={() => void toggleCamera()}>
                {camera ? 'Camera off' : 'Turn camera on'}
              </button>
              <button type="button" aria-pressed={adaptive} onClick={() => void toggleAdaptive()}>
                {adaptive ? 'Adaptive on' : 'Adaptive off'}
              </button>
            </div>
            <div className={styles.quality} aria-live="polite">
              <strong>Video quality</strong>
              {Object.values(quality).length ? (
                Object.values(quality).map((item) => (
                  <span key={`${item.peer}-${item.direction}`}>
                    {item.peer.slice(0, 6)} · {item.direction} · {item.level.replace('-', ' ')}
                    {item.reason !== 'monitoring' && item.reason !== 'recovery' ? ` · ${item.reason.replace('-', ' ')}` : ''}
                  </span>
                ))
              ) : (
                <span>Waiting for a peer</span>
              )}
            </div>
            <div className={styles.people}>
              {localMedia && <MediaTile key={localMedia.id} peer={localMedia} />}
              {Object.values(media).map((peer) => (
                <MediaTile key={peer.id} peer={peer} />
              ))}
              {!Object.keys(media).length && <p className={styles.waiting}>Waiting for your squad. Share the invite link to connect another player.</p>}
            </div>
            <div className={styles.callActions}>
              <button type="button" className={styles.copy} onClick={() => void copyInvite()}>
                Copy invite
              </button>
              <button type="button" className={styles.leave} onClick={() => void leave()}>
                Leave call
              </button>
            </div>
            {!!notice && (
              <p className={styles.notice} role="status">
                {notice}
              </p>
            )}
          </>
        )}
        {!room && notice && phase !== 'error' && (
          <p className={styles.notice} role="status">
            {notice}
          </p>
        )}
        <p className={styles.foot}>
          Solo play works without joining. A public tracker introduces connected browsers. Audio and video travel between participants.
        </p>
      </aside>
    </div>
  );
}
