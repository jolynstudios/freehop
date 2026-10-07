import {useCallback, useEffect, useState} from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';
import {useHistory, useLocation} from '@docusaurus/router';
import Home from './Home';
import Lobby, {type LobbyJoin} from './Lobby';
import Call from './Call';
import {HopperFigure} from './Mark';
import {useCall} from './useCall';
import {cleanName, codeFromHash, newCode, savedName} from './code';
import type {DeviceChoice} from './engine';
import s from './Hopper.module.css';

type View = 'home' | 'lobby' | 'call' | 'left';

/**
 * Hopper: a Meet(up)-like room app on top of Freehop. The room code lives in the URL
 * fragment (/hopper#code), which browsers never send to a web server.
 */
export default function Hopper() {
  const location = useLocation();
  const history = useHistory();
  const call = useCall(useBaseUrl('/lib/client/peerlane.mjs'));
  const [name, setName] = useState(() => savedName.read());
  const [devices, setDevices] = useState<DeviceChoice>({audio: null, video: null, speaker: null});
  const [joinError, setJoinError] = useState<{error: string; micFailed: boolean} | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [leftCode, setLeftCode] = useState<string | null>(null);
  const [lastJoin, setLastJoin] = useState<LobbyJoin>({mic: true, cam: true});

  const {code, malformed} = codeFromHash(location.hash);
  const view: View = call.phase === 'live' && call.code === code ? 'call' : code && leftCode === code ? 'left' : code ? 'lobby' : 'home';

  // A broken code in the link: say so on the home screen and clear the fragment.
  useEffect(() => {
    if (!malformed) return;
    setNotice('That room link is incomplete or mistyped. Ask for the link again, or start a new room.');
    history.replace({pathname: location.pathname, search: location.search, hash: ''});
  }, [malformed, history, location.pathname, location.search]);

  // Show the code in its tidy form (lower case, four groups) in the address bar.
  useEffect(() => {
    if (code && location.hash !== `#${code}`) history.replace({pathname: location.pathname, search: location.search, hash: code});
  }, [code, location.hash, location.pathname, location.search, history]);

  // The address no longer names the room you are in (Back, an edited link): leave it.
  useEffect(() => {
    if (call.code && call.code !== code) {
      setLeftCode(null);
      void call.leave();
    }
  }, [code, call.code, call.leave]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [view]);

  const goTo = useCallback(
    (hash: string) => history.push({pathname: location.pathname, search: location.search, hash}),
    [history, location.pathname, location.search],
  );

  const join = useCallback(
    async (options: LobbyJoin) => {
      if (!code) return;
      const clean = cleanName(name) || 'Guest';
      setName(clean);
      savedName.write(clean);
      setJoinError(null);
      setLeftCode(null);
      setLastJoin(options);
      const result = await call.join({
        code,
        name: clean,
        mic: options.mic,
        cam: options.cam,
        listenOnly: options.listenOnly,
        devices: {audio: devices.audio, video: devices.video},
      });
      if (!result.ok && result.error) setJoinError({error: result.error, micFailed: result.micFailed});
    },
    [code, name, devices, call.join],
  );

  const leave = useCallback(() => {
    setLeftCode(code);
    void call.leave();
  }, [code, call.leave]);

  const rename = useCallback(
    (next: string) => {
      const clean = cleanName(next);
      if (!clean) return;
      setName(clean);
      savedName.write(clean);
      call.rename(clean);
    },
    [call.rename],
  );

  const invite = code ? `${window.location.origin}${location.pathname}#${code}` : '';

  // A small handle for automated checks of this demo.
  useEffect(() => {
    (window as unknown as {hopperDemo: unknown}).hopperDemo = {
      view,
      phase: call.phase,
      code,
      id: call.room?.id ?? null,
      peers: call.peers,
      gates: call.gates,
      mic: call.mic,
      cam: call.cam,
      chat: call.chat.length,
      stats: () => call.room?.stats(),
      // Sends raw data as this participant, to test how the others treat untrusted input.
      debugSend: (data: unknown) => call.room?.send(data),
    };
  }, [view, call.phase, code, call.room, call.peers, call.gates, call.mic, call.cam, call.chat.length]);

  if (view === 'call' && code) {
    return <Call call={call} code={code} invite={invite} name={name} onRename={rename} devices={devices} onDevices={setDevices} onLeave={leave} />;
  }

  if (view === 'left' && code) {
    return (
      <div className={s.scene}>
        <div className={s.leftInner}>
          <svg className={s.leftArt} viewBox="0 0 220 110" aria-hidden="true">
            <path d="M18 100 Q110 -16 202 100" fill="none" stroke="#333333" strokeWidth={4.5} strokeLinecap="round" strokeDasharray="0.1 13" />
            <g transform="translate(188 74) rotate(8)">
              <HopperFigure scale={0.8} />
            </g>
          </svg>
          <h1 className={s.leftTitle}>You left the room.</h1>
          <p className={s.leftText}>Your camera and microphone are off. The room carries on for anyone still in it.</p>
          <div className={s.leftActions}>
            <button type="button" className={s.primary} onClick={() => void join(lastJoin)}>
              Rejoin
            </button>
            <button
              type="button"
              className={s.secondary}
              onClick={() => {
                setLeftCode(null);
                setNotice(null);
                goTo('');
              }}
            >
              Return to home screen
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'lobby' && code) {
    return (
      <Lobby
        code={code}
        invite={invite}
        name={name}
        onName={setName}
        devices={devices}
        onDevices={setDevices}
        joining={call.phase === 'joining'}
        error={joinError?.error ?? null}
        micFailed={joinError?.micFailed ?? false}
        onJoin={(options) => void join(options)}
        onHome={() => {
          setJoinError(null);
          goTo('');
        }}
      />
    );
  }

  return (
    <Home
      notice={notice}
      onNew={() => {
        setNotice(null);
        setJoinError(null);
        goTo(newCode());
      }}
      onJoin={(next) => {
        setNotice(null);
        setJoinError(null);
        goTo(next);
      }}
    />
  );
}
