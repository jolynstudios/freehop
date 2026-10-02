import {useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import {Lockup} from './Home';
import {HopperFigure} from './Mark';
import {CamIcon, CamOffIcon, CheckIcon, CopyIcon, MicIcon, MicOffIcon} from './Icons';
import {DeviceSelect} from './Call';
import {useLevel} from './useSpeaking';
import {NAME_MAX, cleanName, initials} from './code';
import {cameraProblem, canPickSpeaker, listDevices, micProblem, type DeviceChoice, type DeviceLists} from './engine';
import s from './Hopper.module.css';

const MIC = {echoCancellation: true, noiseSuppression: true, autoGainControl: true};
const CAM = {width: {ideal: 640}, height: {ideal: 360}, frameRate: {ideal: 24, max: 30}};

type Kind = 'audio' | 'video';
const constraints = (kind: Kind, deviceId: string | null) => {
  const base = kind === 'audio' ? MIC : CAM;
  return deviceId ? {...base, deviceId: {exact: deviceId}} : base;
};

/**
 * The waiting room's own preview. It asks for devices only when the visitor presses the check
 * button, and it stops every track before joining (Freehop captures its own), on unmount and
 * when the page is hidden.
 */
function usePreview() {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [state, setState] = useState<'off' | 'starting' | 'on'>('off');
  const [errors, setErrors] = useState<{audio: string | null; video: string | null}>({audio: null, video: null});
  const current = useRef<MediaStream | null>(null);
  const generation = useRef(0);

  const publish = (next: MediaStream | null) => {
    current.current = next;
    setStream(next ? new MediaStream(next.getTracks()) : null);
  };

  const stop = useCallback(() => {
    generation.current++;
    for (const track of current.current?.getTracks() ?? []) track.stop();
    current.current = null;
    setStream(null);
    setState('off');
  }, []);

  useEffect(() => {
    window.addEventListener('pagehide', stop);
    return () => {
      window.removeEventListener('pagehide', stop);
      stop();
    };
  }, [stop]);

  const start = useCallback(
    async ({mic, cam, devices}: {mic: boolean; cam: boolean; devices: DeviceChoice}) => {
      stop();
      const g = generation.current;
      setState('starting');
      setErrors({audio: null, video: null});
      const tracks: MediaStreamTrack[] = [];
      const problems: {audio: string | null; video: string | null} = {audio: null, video: null};
      const kinds: Kind[] = cam ? ['audio', 'video'] : ['audio'];
      try {
        // One request for both shows a single permission prompt.
        const both = await navigator.mediaDevices.getUserMedia({
          audio: constraints('audio', devices.audio),
          video: cam ? constraints('video', devices.video) : false,
        });
        tracks.push(...both.getTracks());
      } catch {
        // Find out which device is the problem, so the other one still works.
        for (const kind of kinds) {
          try {
            const one = await navigator.mediaDevices.getUserMedia({[kind]: constraints(kind, devices[kind])});
            tracks.push(...one.getTracks());
          } catch (e) {
            problems[kind] = kind === 'audio' ? micProblem(e as Error) : cameraProblem(e as Error);
          }
        }
      }
      if (g !== generation.current) {
        for (const track of tracks) track.stop();
        return;
      }
      for (const track of tracks) if (track.kind === 'audio') track.enabled = mic;
      publish(new MediaStream(tracks.filter(t => t.readyState === 'live')));
      setErrors(problems);
      setState('on');
    },
    [stop],
  );

  const setEnabled = useCallback(
    async (kind: Kind, on: boolean, deviceId: string | null) => {
      const live = current.current;
      if (!live) return;
      const existing = live.getTracks().find(t => t.kind === kind);
      if (kind === 'audio' && existing) {
        existing.enabled = on;
        publish(live);
        return;
      }
      if (!on) {
        if (existing) {
          existing.stop();
          live.removeTrack(existing);
          publish(live);
        }
        return;
      }
      if (existing) return;
      const g = generation.current;
      try {
        const captured = await navigator.mediaDevices.getUserMedia({[kind]: constraints(kind, deviceId)});
        const track = captured.getTracks()[0];
        if (g !== generation.current || current.current !== live) {
          track?.stop();
          return;
        }
        if (track) live.addTrack(track);
        publish(live);
        setErrors(e => ({...e, [kind]: null}));
      } catch (e) {
        setErrors(prev => ({...prev, [kind]: kind === 'audio' ? micProblem(e as Error) : cameraProblem(e as Error)}));
      }
    },
    [],
  );

  const swap = useCallback(async (kind: Kind, deviceId: string | null, enabled: boolean) => {
    const live = current.current;
    const old = live?.getTracks().find(t => t.kind === kind);
    if (!live || !old) return;
    const g = generation.current;
    try {
      const captured = await navigator.mediaDevices.getUserMedia({[kind]: constraints(kind, deviceId)});
      const track = captured.getTracks()[0];
      if (g !== generation.current || current.current !== live) {
        track?.stop();
        return;
      }
      old.stop();
      live.removeTrack(old);
      if (track) {
        track.enabled = enabled;
        live.addTrack(track);
      }
      publish(live);
      setErrors(e => ({...e, [kind]: null}));
    } catch (e) {
      setErrors(prev => ({...prev, [kind]: kind === 'audio' ? micProblem(e as Error) : cameraProblem(e as Error)}));
    }
  }, []);

  return {stream, state, errors, start, stop, setEnabled, swap};
}

export type LobbyJoin = {mic: boolean; cam: boolean; listenOnly?: boolean};

type LobbyProps = {
  code: string;
  invite: string;
  name: string;
  onName(name: string): void;
  devices: DeviceChoice;
  onDevices(next: DeviceChoice): void;
  joining: boolean;
  error: string | null;
  micFailed: boolean;
  onJoin(options: LobbyJoin): void;
  onHome(): void;
};

/** The waiting room: check how you look and sound, pick devices, set your name, join. */
export default function Lobby({code, invite, name, onName, devices, onDevices, joining, error, micFailed, onJoin, onHome}: LobbyProps) {
  const preview = usePreview();
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);
  const [lists, setLists] = useState<DeviceLists | null>(null);
  const [nameError, setNameError] = useState(false);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const nameInput = useRef<HTMLInputElement>(null);
  const video = useRef<HTMLVideoElement>(null);

  const videoTrack = preview.stream?.getVideoTracks()[0] ?? null;
  const audioTrack = preview.stream?.getAudioTracks()[0] ?? null;
  const level = useLevel(audioTrack);

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    el.srcObject = videoTrack ? new MediaStream([videoTrack]) : null;
    if (videoTrack) el.play().catch(() => {});
  }, [videoTrack]);

  // Device names are only available once the browser granted access in the check.
  useEffect(() => {
    if (preview.state !== 'on') return;
    let live = true;
    const refresh = () =>
      void listDevices().then(next => {
        if (live) setLists(next);
      });
    refresh();
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
    return () => {
      live = false;
      navigator.mediaDevices?.removeEventListener?.('devicechange', refresh);
    };
  }, [preview.state]);

  useEffect(() => {
    if (copied === 'idle') return;
    const timer = window.setTimeout(() => setCopied('idle'), 2200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const check = () => void preview.start({mic, cam, devices});

  const toggleMic = () => {
    const next = !mic;
    setMic(next);
    void preview.setEnabled('audio', next, devices.audio);
  };
  const toggleCam = () => {
    const next = !cam;
    setCam(next);
    void preview.setEnabled('video', next, devices.video);
  };

  const pick = (kind: Kind) => (event: ChangeEvent<HTMLSelectElement>) => {
    const id = event.target.value || null;
    onDevices({...devices, [kind]: id});
    void preview.swap(kind, id, kind === 'audio' ? mic : true);
  };

  const join = (listenOnly = false) => (event?: FormEvent) => {
    event?.preventDefault();
    if (!cleanName(name)) {
      setNameError(true);
      nameInput.current?.focus();
      return;
    }
    // Freehop captures its own devices: release the preview first so a camera is never held twice.
    preview.stop();
    onJoin({mic: listenOnly ? false : mic, cam, listenOnly});
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invite);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  };

  const showVideo = !!videoTrack && cam;
  const displayName = cleanName(name) || 'You';

  return (
    <div className={s.scene}>
      <div className={s.lobbyInner}>
        <div className={s.lobbyStage}>
          <div className={s.preview} data-preview={preview.state}>
            <video ref={video} className={clsx(s.previewVideo, !showVideo && s.previewHidden)} autoPlay playsInline muted />
            {!showVideo && (
              <div className={s.previewEmpty}>
                {preview.state === 'off' ? (
                  <>
                    <svg className={s.previewHopper} viewBox="0 0 120 92" aria-hidden="true">
                      <path d="M10 86 Q60 -10 110 86" fill="none" stroke="#5c5c5c" strokeWidth={4} strokeLinecap="round" strokeDasharray="0.1 11" />
                      <g transform="translate(60 48)">
                        <HopperFigure scale={0.7} />
                      </g>
                    </svg>
                    <p className={s.previewText}>Your camera and microphone stay off until you check them.</p>
                    <button type="button" className={s.checkButton} onClick={check}>
                      Check your camera and microphone
                    </button>
                  </>
                ) : preview.state === 'starting' ? (
                  <p className={s.previewText} role="status">
                    Waiting for your browser. Allow the camera and microphone when it asks.
                  </p>
                ) : (
                  <>
                    <span className={s.previewAvatar} aria-hidden="true">
                      {initials(displayName)}
                    </span>
                    <p className={s.previewText}>{cam ? 'No camera picture.' : 'Your camera is off.'}</p>
                  </>
                )}
              </div>
            )}
            {preview.state === 'on' && (
              <span className={s.previewName}>{displayName}</span>
            )}
            <div className={s.previewControls}>
              <button
                type="button"
                className={clsx(s.roundButton, !mic && s.roundOff)}
                onClick={toggleMic}
                aria-label={mic ? 'Turn off microphone' : 'Turn on microphone'}
                data-tip={mic ? 'Turn off microphone' : 'Turn on microphone'}>
                {mic ? <MicIcon /> : <MicOffIcon />}
              </button>
              <button
                type="button"
                className={clsx(s.roundButton, !cam && s.roundOff)}
                onClick={toggleCam}
                aria-label={cam ? 'Turn off camera' : 'Turn on camera'}
                data-tip={cam ? 'Turn off camera' : 'Turn on camera'}>
                {cam ? <CamIcon /> : <CamOffIcon />}
              </button>
              {preview.state === 'on' && audioTrack && (
                <span className={s.meter} role="img" aria-label={mic ? 'Microphone level' : 'Microphone off'}>
                  {[0, 1, 2, 3, 4].map(i => (
                    <i key={i} className={clsx(mic && level > i / 5 + 0.04 && s.meterOn)} />
                  ))}
                </span>
              )}
            </div>
          </div>

          {(preview.errors.audio || preview.errors.video) && (
            <div className={s.previewErrors} role="alert">
              {preview.errors.audio && <p>{preview.errors.audio}</p>}
              {preview.errors.video && <p>{preview.errors.video}</p>}
            </div>
          )}

          {preview.state === 'on' && lists ? (
            <div className={s.pickers}>
              <DeviceSelect id="lobby-mic" label="Microphone" value={devices.audio} options={lists.audio} fallback="Microphone" onChange={pick('audio')} className={s.picker} />
              <DeviceSelect id="lobby-cam" label="Camera" value={devices.video} options={lists.video} fallback="Camera" onChange={pick('video')} className={s.picker} />
              {canPickSpeaker() && (
                <DeviceSelect
                  id="lobby-speaker"
                  label="Speaker"
                  value={devices.speaker}
                  options={lists.speaker}
                  fallback="Speaker"
                  onChange={e => onDevices({...devices, speaker: e.target.value || null})}
                  className={s.picker}
                />
              )}
            </div>
          ) : (
            <p className={s.pickerHint}>After the check you can pick your camera, microphone{canPickSpeaker() ? ' and speaker' : ''} here.</p>
          )}
        </div>

        <form className={s.lobbyPanel} onSubmit={join(false)} noValidate>
          <Lockup className={s.lobbyLockup} />
          <p className={s.eyebrow}>Waiting room</p>
          <h1 className={s.lobbyTitle}>Ready to hop in?</h1>
          <p className={s.lobbyText}>Check how you look and sound first, if you like.</p>

          <label className={s.fieldLabel} htmlFor="hopper-name">
            Your name
          </label>
          <input
            id="hopper-name"
            ref={nameInput}
            className={clsx(s.nameInput, nameError && s.nameInputError)}
            value={name}
            maxLength={NAME_MAX}
            autoComplete="nickname"
            placeholder="What should people call you?"
            aria-invalid={nameError ? true : undefined}
            aria-describedby="hopper-name-help"
            onChange={e => {
              onName(cleanName(e.target.value, {trim: false}));
              setNameError(false);
            }}
          />
          <p id="hopper-name-help" className={clsx(s.fieldHelp, nameError && s.fieldHelpError)}>
            {nameError ? 'Add your name so the others know who joined.' : 'Shown to the others in this meeting and remembered on this device.'}
          </p>

          {error && (
            <div className={s.joinError} role="alert">
              <p>{error}</p>
              {micFailed && (
                <button type="button" className={s.secondarySmall} onClick={() => join(true)()} disabled={joining}>
                  Join without a microphone
                </button>
              )}
            </div>
          )}

          <button type="submit" className={s.joinNow} disabled={joining}>
            {joining ? 'Joining…' : 'Join now'}
          </button>

          <div className={s.codeBox}>
            <span className={s.codeText}>
              <span className={s.codeLabel}>Meeting code</span>
              <code className={s.codeValue}>{code}</code>
            </span>
            <button type="button" className={s.copyButton} onClick={() => void copy()}>
              {copied === 'copied' ? <CheckIcon width={18} height={18} /> : <CopyIcon width={18} height={18} />}
              {copied === 'copied' ? 'Link copied' : copied === 'failed' ? 'Copy failed: use the address bar' : 'Copy joining link'}
            </button>
          </div>

          <p className={s.lobbyFoot}>
            Hopper is a Meet(up)-like demo powered by <Link to="/docs">Freehop</Link>. Your browser connects straight to the others in this
            meeting. Not this meeting?{' '}
            <button type="button" className={s.inlineLink} onClick={onHome}>
              Back to the start
            </button>
          </p>
        </form>
      </div>
    </div>
  );
}
