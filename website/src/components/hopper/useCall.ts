import {useCallback, useEffect, useReducer, useRef, useState} from 'react';
import type {PathKind} from '../PathBadge';
import {APP, STUN, TRACKERS, cameraProblem, micProblem, trackerKey, type ClientModule, type FreehopRoom} from './engine';
import {cleanChat, parseMessage} from './code';

export type Peer = {
  id: string;
  name: string | null;
  /** What the person last told us about their microphone and camera; null until they say. */
  mic: boolean | null;
  cam: boolean | null;
  path: PathKind;
  via: string | null;
  connected: boolean;
  frames: number;
};

export type ChatLine = {key: number; from: string; name: string; text: string; at: number; mine: boolean};

export type JoinOptions = {
  code: string;
  name: string;
  mic: boolean;
  cam: boolean;
  /** Join without capturing a microphone, to listen only. */
  listenOnly?: boolean;
  devices: {audio: string | null; video: string | null};
};

export type JoinResult = {ok: true} | {ok: false; error: string | null; micFailed: boolean};

const CHAT_WINDOW_MS = 10000;
const CHAT_BURST = 5;
const CHAT_KEEP = 200;
const DEVICE_ERRORS = new Set(['NotAllowedError', 'SecurityError', 'NotFoundError', 'NotReadableError', 'AbortError', 'OverconstrainedError']);

const idleGates = () => Object.fromEntries(TRACKERS.map(t => [t, 'idle']));
const blank = (id: string): Peer => ({id, name: null, mic: null, cam: null, path: 'connecting', via: null, connected: false, frames: 0});

/**
 * One Freehop room for Hopper: join, leave, devices, names, chat and live link state.
 * The engine is Freehop's own browser client, loaded from static/lib at runtime.
 */
export function useCall(moduleUrl: string) {
  const [phase, setPhase] = useState<'idle' | 'joining' | 'live'>('idle');
  const [code, setCode] = useState<string | null>(null);
  const [room, setRoom] = useState<FreehopRoom | null>(null);
  const [peers, setPeers] = useState<Record<string, Peer>>({});
  const [streams, setStreams] = useState<Record<string, MediaStream>>({});
  const [gates, setGates] = useState<Record<string, string>>(idleGates);
  const [mic, setMic] = useState(false);
  const [cam, setCam] = useState(false);
  const [camBusy, setCamBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [lonely, setLonely] = useState(false);
  const [trackersDown, setTrackersDown] = useState(false);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [localVersion, bumpLocal] = useReducer((n: number) => n + 1, 0);

  const roomRef = useRef<FreehopRoom | null>(null);
  const me = useRef({name: '', mic: false, cam: false});
  const peersRef = useRef(peers);
  useEffect(() => {
    peersRef.current = peers;
  }, [peers]);
  const generation = useRef(0);
  const joining = useRef(false);
  const camBusyRef = useRef(false);
  const alive = useRef(true);
  const chatKey = useRef(0);
  const sentAt = useRef<number[]>([]);

  const hello = useCallback((r: FreehopRoom, to?: string) => {
    const {name, mic: m, cam: c} = me.current;
    void r.send({type: 'hello', name, mic: m, cam: c}, to ? {to} : {}).catch(() => {});
  }, []);

  const tellState = useCallback((r: FreehopRoom) => {
    void r.send({type: 'state', mic: me.current.mic, cam: me.current.cam}).catch(() => {});
  }, []);

  const wire = useCallback(
    (r: FreehopRoom) => {
      const current = () => roomRef.current === r;
      r.on('gate', ({url, state}) => {
        if (current()) setGates(g => ({...g, [trackerKey(url)]: state}));
      });
      r.on('peer', ({id}) => {
        if (!current()) return;
        setPeers(p => (p[id] ? p : {...p, [id]: blank(id)}));
        hello(r, id);
      });
      r.on('link', ({peer, connected}) => {
        if (!current()) return;
        setPeers(p => (p[peer] ? {...p, [peer]: {...p[peer], connected: !!connected}} : p));
        // A fresh link is a good moment to (re)introduce ourselves: names are never lost.
        if (connected) hello(r, peer);
      });
      r.on('peer-left', ({id}) => {
        if (!current()) return;
        setPeers(p => {
          if (!p[id]) return p;
          const next = {...p};
          delete next[id];
          return next;
        });
        setStreams(st => {
          if (!st[id]) return st;
          const next = {...st};
          delete next[id];
          return next;
        });
      });
      r.on('path', ({peer, kind, via}) => {
        if (!current()) return;
        setPeers(p => (p[peer] ? {...p, [peer]: {...p[peer], path: kind as PathKind, via: via ?? null}} : p));
      });
      r.on('track', ({peer, track}: {peer: string; track: MediaStreamTrack}) => {
        if (!current()) return;
        setStreams(st => {
          const kept = (st[peer]?.getTracks() ?? []).filter(t => t.kind !== track.kind && t.readyState === 'live');
          return {...st, [peer]: new MediaStream([...kept, track])};
        });
        track.addEventListener('ended', () =>
          setStreams(st => {
            const stream = st[peer];
            if (!stream?.getTracks().includes(track)) return st;
            return {...st, [peer]: new MediaStream(stream.getTracks().filter(t => t !== track && t.readyState === 'live'))};
          }),
        );
      });
      r.on('message', ({from, data}) => {
        if (!current() || typeof from !== 'string') return;
        const message = parseMessage(data);
        if (!message) return;
        if (message.type === 'chat') {
          const name = peersRef.current[from]?.name ?? 'Guest';
          setChat(c => [...c, {key: ++chatKey.current, from, name, text: message.text, at: Date.now(), mine: false}].slice(-CHAT_KEEP));
          return;
        }
        // Only members the engine announced get a tile; the 'peer' event always comes first.
        setPeers(p => {
          if (!p[from]) return p;
          const next = {...p[from]};
          if (message.type === 'hello' && message.name) next.name = message.name;
          if (message.mic !== null) next.mic = message.mic;
          if (message.cam !== null) next.cam = message.cam;
          return {...p, [from]: next};
        });
      });
    },
    [hello],
  );

  const turnCamera = useCallback(
    async (r: FreehopRoom, on: boolean) => {
      camBusyRef.current = true;
      setCamBusy(true);
      try {
        await r.setCamera(on);
        if (roomRef.current !== r) return;
        me.current.cam = on;
        setCam(on);
        setNotice(null);
        bumpLocal();
        tellState(r);
      } catch (e) {
        if (roomRef.current === r) setNotice(cameraProblem(e as Error));
      } finally {
        camBusyRef.current = false;
        setCamBusy(false);
      }
    },
    [tellState],
  );

  const join = useCallback(
    async (options: JoinOptions): Promise<JoinResult> => {
      if (roomRef.current || joining.current) return {ok: false, error: null, micFailed: false};
      joining.current = true;
      const g = ++generation.current;
      me.current = {name: options.name, mic: options.mic && !options.listenOnly, cam: false};
      setPeers({});
      setStreams({});
      setChat([]);
      setNotice(null);
      setLonely(false);
      setTrackersDown(false);
      setCode(options.code);
      setPhase('joining');
      setGates(Object.fromEntries(TRACKERS.map(t => [t, 'connecting'])));
      try {
        const mod: ClientModule = await import(/* webpackIgnore: true */ moduleUrl);
        // Join with the microphone only; the camera is added afterwards, so a busy or blocked
        // camera never keeps anyone out of the meeting.
        const base = {gates: TRACKERS, stun: STUN, secret: options.code, app: APP, media: {audio: !options.listenOnly, video: false}};
        let r: FreehopRoom;
        try {
          r = await mod.join({...base, devices: options.devices});
        } catch (e) {
          // A remembered device that has gone away: try once more with the defaults.
          if ((e as Error).name !== 'OverconstrainedError' || (!options.devices.audio && !options.devices.video)) throw e;
          r = await mod.join({...base, devices: {audio: null, video: null}});
        }
        if (!alive.current || g !== generation.current) {
          await r.leave();
          return {ok: false, error: null, micFailed: false};
        }
        roomRef.current = r;
        setRoom(r);
        wire(r);
        if (!me.current.mic && !options.listenOnly) await r.setMicrophone(false);
        setMic(me.current.mic);
        setCam(false);
        bumpLocal();
        setPhase('live');
        joining.current = false;
        if (options.cam) await turnCamera(r, true);
        return {ok: true};
      } catch (e) {
        if (g === generation.current) {
          // Never keep a half-joined room (or its devices) around after a failure.
          const stray = roomRef.current;
          roomRef.current = null;
          void stray?.leave();
          setRoom(null);
          setPhase('idle');
          setCode(null);
          setGates(idleGates());
        }
        const err = e as Error;
        const micFailed = DEVICE_ERRORS.has(err.name);
        return {ok: false, error: micFailed ? micProblem(err) : `Hopper could not join this meeting (${err.message}).`, micFailed};
      } finally {
        joining.current = false;
      }
    },
    [moduleUrl, wire, turnCamera],
  );

  const leave = useCallback(async () => {
    generation.current++;
    const r = roomRef.current;
    roomRef.current = null;
    me.current.cam = false;
    sentAt.current = [];
    setRoom(null);
    setPeers({});
    setStreams({});
    setChat([]);
    setPhase('idle');
    setCode(null);
    setMic(false);
    setCam(false);
    setNotice(null);
    setLonely(false);
    setTrackersDown(false);
    setGates(idleGates());
    // leave() says goodbye, closes every link and stops the devices Freehop captured.
    await r?.leave();
  }, []);

  // Leaving the page or closing the tab leaves the meeting and frees the devices at once.
  const leaveRef = useRef(leave);
  useEffect(() => {
    leaveRef.current = leave;
  }, [leave]);
  useEffect(() => {
    alive.current = true;
    const onHide = () => void leaveRef.current();
    window.addEventListener('pagehide', onHide);
    return () => {
      alive.current = false;
      window.removeEventListener('pagehide', onHide);
      generation.current++;
      const r = roomRef.current;
      roomRef.current = null;
      void r?.leave();
    };
  }, []);

  const toggleMic = useCallback(async () => {
    const r = roomRef.current;
    if (!r) return;
    const next = !me.current.mic;
    try {
      await r.setMicrophone(next);
    } catch (e) {
      if (roomRef.current === r) setNotice(micProblem(e as Error));
      return;
    }
    if (roomRef.current !== r) return;
    me.current.mic = next;
    setMic(next);
    bumpLocal();
    tellState(r);
  }, [tellState]);

  const toggleCam = useCallback(async () => {
    const r = roomRef.current;
    if (!r || camBusyRef.current) return;
    await turnCamera(r, !me.current.cam);
  }, [turnCamera]);

  const switchDevice = useCallback(async (kind: 'audio' | 'video', deviceId: string | null) => {
    const r = roomRef.current;
    if (!r) return;
    try {
      await r.switchDevice(kind, deviceId);
      if (roomRef.current !== r) return;
      setNotice(null);
      bumpLocal();
    } catch (e) {
      if (roomRef.current === r) setNotice(kind === 'audio' ? micProblem(e as Error) : cameraProblem(e as Error));
    }
  }, []);

  const rename = useCallback(
    (name: string) => {
      me.current.name = name;
      const r = roomRef.current;
      if (r) hello(r);
    },
    [hello],
  );

  /** Sends a chat line to everyone; at most 5 lines per 10 seconds. */
  const sendChat = useCallback((raw: string): {ok: true} | {ok: false; waitMs: number} => {
    const r = roomRef.current;
    const text = cleanChat(raw);
    if (!r || !text) return {ok: false, waitMs: 0};
    const now = Date.now();
    sentAt.current = sentAt.current.filter(t => now - t < CHAT_WINDOW_MS);
    if (sentAt.current.length >= CHAT_BURST) return {ok: false, waitMs: CHAT_WINDOW_MS - (now - sentAt.current[0])};
    sentAt.current.push(now);
    void r.send({type: 'chat', text}).catch(() => {});
    setChat(c => [...c, {key: ++chatKey.current, from: r.id, name: me.current.name, text, at: now, mine: true}].slice(-CHAT_KEEP));
    return {ok: true};
  }, []);

  // Live link state from the engine's stats: path, connection, decoded video frames, trackers.
  useEffect(() => {
    if (!room) return;
    let live = true;
    const started = Date.now();
    const tick = async () => {
      try {
        const st = await room.stats();
        if (!live) return;
        setGates(Object.fromEntries(st.gates.map(gate => [trackerKey(gate.url), gate.state])));
        setPeers(p => {
          let changed = false;
          const next = {...p};
          for (const link of st.links) {
            // A snapshot can outlive a departure: never bring back someone who left.
            const before = next[link.peer];
            if (!before) continue;
            const after = {
              ...before,
              path: link.path.kind,
              via: link.path.via ?? null,
              connected: link.connected || link.path.kind === 'bridged',
              frames: link.media.inbound.video?.frames ?? 0,
            };
            if (before.path !== after.path || before.via !== after.via || before.connected !== after.connected || before.frames !== after.frames) {
              next[link.peer] = after;
              changed = true;
            }
          }
          return changed ? next : p;
        });
        const waited = Date.now() - started;
        setLonely(st.links.length === 0 && waited > 30000);
        setTrackersDown(!st.gates.some(gate => gate.state === 'joined') && waited > 12000);
      } catch {
        /* the room may be closing */
      }
    };
    const timer = window.setInterval(tick, 1500);
    void tick();
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [room]);

  return {
    phase,
    code,
    room,
    peers,
    streams,
    gates,
    mic,
    cam,
    camBusy,
    notice,
    setNotice,
    lonely,
    trackersDown,
    chat,
    localVersion,
    join,
    leave,
    toggleMic,
    toggleCam,
    switchDevice,
    rename,
    sendChat,
  };
}

export type CallState = ReturnType<typeof useCall>;
