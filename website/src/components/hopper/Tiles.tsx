import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode} from 'react';
import clsx from 'clsx';
import PathBadge, {type PathKind} from '../PathBadge';
import {avatarTone, initials} from './code';
import {MicOffIcon} from './Icons';
import s from './Call.module.css';

const MIN_ASPECT = 0.75; // 3:4, the tallest a tile may get
const MAX_ASPECT = 1.9; // a little wider than 16:9
const IDEAL = 16 / 9;

/** Picks the column count whose tiles are biggest and closest to 16:9 for n tiles in a W×H box. */
export function fitTiles(n: number, width: number, height: number, gap: number) {
  let best = {cols: 1, w: 0, h: 0, score: -1};
  if (n < 1 || width <= 0 || height <= 0) return best;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    let w = (width - gap * (cols - 1)) / cols;
    let h = (height - gap * (rows - 1)) / rows;
    if (w <= 0 || h <= 0) continue;
    if (w / h > MAX_ASPECT) w = h * MAX_ASPECT;
    if (w / h < MIN_ASPECT) h = w / MIN_ASPECT;
    const aspect = w / h;
    const score = w * h * (Math.min(aspect, IDEAL) / Math.max(aspect, IDEAL));
    if (score > best.score) best = {cols, w, h, score};
  }
  return {...best, w: Math.floor(best.w), h: Math.floor(best.h)};
}

/** Measures the stage and lays out n tiles in it. */
export function useTileLayout(n: number, gap: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({w: 0, h: 0});
  const update = useCallback((w: number, h: number) => setBox(b => (Math.abs(b.w - w) < 1 && Math.abs(b.h - h) < 1 ? b : {w, h})), []);
  /** Measures now; call it from a layout effect when something resizes the stage, so the next paint is right. */
  const measure = useCallback(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect) update(rect.width, rect.height);
  }, [update]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const observer = new ResizeObserver(([entry]) => update(entry.contentRect.width, entry.contentRect.height));
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, update]);
  const layout = useMemo(() => fitTiles(n, box.w, box.h, gap), [n, box, gap]);
  return {ref, measure, box, ...layout};
}

function useVideo(stream: MediaStream | null) {
  const video = useRef<HTMLVideoElement>(null);
  const [, repaint] = useState(0);
  // Tracks can be added to or removed from the same stream (camera on/off, another camera):
  // re-attach when they change, and repaint when a track mutes, unmutes or ends.
  const trackKey = stream ? stream.getTracks().map(t => `${t.id}:${t.readyState}`).join(',') : '';
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    el.srcObject = null;
    el.srcObject = stream;
    if (stream) el.play().catch(() => {});
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
  }, [stream, trackKey]);
  useEffect(() => {
    const el = video.current;
    return () => {
      if (el) el.srcObject = null;
    };
  }, []);
  const live = !!stream?.getVideoTracks().some(t => t.readyState === 'live' && t.enabled && !t.muted);
  return {video, live};
}

type TileProps = {
  id: string;
  name: string;
  self?: boolean;
  stream: MediaStream | null;
  /** False when the person said their camera is off: a frozen last frame is never shown. */
  camera: boolean;
  mic: boolean | null;
  speaking: boolean;
  path?: PathKind;
  via?: string | null;
  status?: string | null;
  style?: CSSProperties;
  className?: string;
  children?: ReactNode;
};

/** One person in the call: video or avatar, name, microphone state, speaking ring and path. */
export function Tile({id, name, self, stream, camera, mic, speaking, path, via, status, style, className, children}: TileProps) {
  const {video, live} = useVideo(stream);
  const showVideo = camera && live;
  const label = self ? `${name} (you)` : name;
  const state = [mic === false ? 'microphone off' : null, showVideo ? null : 'camera off', speaking && mic !== false ? 'speaking' : null].filter(Boolean).join(', ');
  return (
    <figure
      className={clsx(s.tile, speaking && mic !== false && s.speaking, className)}
      style={style}
      data-peer={id}
      data-self={self ? 'true' : undefined}
      data-name={name}
      data-mic={mic === false ? 'off' : 'on'}
      data-cam={showVideo ? 'on' : 'off'}
      data-speaking={speaking && mic !== false ? 'true' : 'false'}
      aria-label={state ? `${label}: ${state}` : label}>
      <video ref={video} autoPlay playsInline muted className={clsx(s.video, self && s.mirrored, !showVideo && s.hiddenVideo)} />
      {!showVideo && (
        <div className={s.avatarWrap} aria-hidden="true">
          <span className={clsx(s.avatar, s[`tone_${avatarTone(id)}`])}>{initials(name)}</span>
          {status && <span className={s.avatarStatus}>{status}</span>}
        </div>
      )}
      {path && !self && (
        <div className={s.tileTop}>
          <PathBadge kind={path} via={via && path !== 'direct' ? via.slice(0, 6) : undefined} size="sm" className={s.pathBadge} />
        </div>
      )}
      <div className={s.tileState} aria-hidden="true">
        {mic === false ? (
          <span className={s.mutedBadge} title="Microphone off">
            <MicOffIcon width={16} height={16} />
          </span>
        ) : speaking ? (
          <span className={s.talkBadge}>
            <i />
            <i />
            <i />
          </span>
        ) : null}
      </div>
      <figcaption className={s.nameTag}>
        <span className={s.nameText}>{name}</span>
        {self && <span className={s.youText}>you</span>}
      </figcaption>
      {children}
    </figure>
  );
}

type Playback = 'waiting' | 'playing' | 'blocked' | 'error';

/**
 * A remote person's sound, played by its own audio element so camera changes never reload it.
 * When the browser blocks autoplay, the tile offers Enable sound; play() runs inside the click.
 */
export function RemoteAudio({peer, stream, speaker, onPlayback, register}: {
  peer: string;
  stream: MediaStream | undefined;
  speaker: string | null;
  onPlayback(peer: string, state: Playback): void;
  register(peer: string, play: (() => void) | null): void;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const generation = useRef(0);
  const reportPlayback = useRef(onPlayback);
  useEffect(() => {
    reportPlayback.current = onPlayback;
  }, [onPlayback]);
  const report = useRef((state: Playback) => reportPlayback.current(peer, state));
  const play = useCallback(() => {
    const el = audio.current;
    if (!(el?.srcObject instanceof MediaStream) || !el.srcObject.getAudioTracks().length) return;
    const current = generation.current;
    void el
      .play()
      .then(() => {
        if (generation.current === current) report.current('playing');
      })
      .catch((error: Error) => {
        if (generation.current === current) report.current(error.name === 'NotAllowedError' ? 'blocked' : 'error');
      });
  }, []);
  useEffect(() => {
    register(peer, play);
    return () => register(peer, null);
  }, [peer, play, register]);
  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    const tracks = stream?.getAudioTracks().filter(t => t.readyState === 'live') ?? [];
    const attached = el.srcObject instanceof MediaStream ? el.srcObject.getAudioTracks() : [];
    // Camera changes must not reload an already-playing audio element or lose its permission.
    if (tracks.length === attached.length && tracks.every((t, i) => t === attached[i])) return;
    generation.current++;
    el.srcObject = tracks.length ? new MediaStream(tracks) : null;
    report.current('waiting');
    play();
  }, [stream, play]);
  useEffect(() => {
    const el = audio.current as (HTMLAudioElement & {setSinkId?: (id: string) => Promise<void>}) | null;
    if (!el?.setSinkId) return;
    el.setSinkId(speaker ?? '').catch(() => {});
  }, [speaker]);
  useEffect(() => {
    const el = audio.current;
    return () => {
      generation.current++;
      if (el) {
        el.pause();
        el.srcObject = null;
      }
    };
  }, []);
  return (
    <audio
      ref={audio}
      onPlaying={() => report.current('playing')}
      onPause={() => {
        if (audio.current?.srcObject) report.current('error');
      }}
      onError={() => report.current('error')}
    />
  );
}

export type {Playback};
