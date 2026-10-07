import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import clsx from 'clsx';
import PathBadge from '../PathBadge';
import HopperMark, {HopperFigure} from './Mark';
import {
  CamIcon,
  CamOffIcon,
  CaretIcon,
  ChatIcon,
  CheckIcon,
  CloseIcon,
  CopyIcon,
  InfoIcon,
  LeaveIcon,
  MicIcon,
  MicOffIcon,
  PeopleIcon,
  SendIcon,
} from './Icons';
import {RemoteAudio, Tile, useTileLayout, type Playback} from './Tiles';
import {useSpeaking, type AudioSource} from './useSpeaking';
import {CHAT_MAX, NAME_MAX, avatarTone, cleanName, initials} from './code';
import {TRACKERS, canPickSpeaker, listDevices, trackerName, type DeviceChoice, type DeviceLists} from './engine';
import type {CallState, ChatLine, Peer} from './useCall';
import s from './Call.module.css';

type PanelKind = 'people' | 'chat' | 'info' | 'devices';

const GATE_STATE: Record<string, string> = {
  joined: 'connected',
  connecting: 'connecting',
  reconnecting: 'reconnecting',
  idle: 'retrying',
  error: 'unreachable',
  closed: 'closed',
};
const timeFormat = new Intl.DateTimeFormat(undefined, {hour: 'numeric', minute: '2-digit'});

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 10000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** Copies text and reports how it went, for a moment. */
function useCopy() {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = useCallback(async (text: string) => {
    window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
    timer.current = window.setTimeout(() => setState('idle'), 2200);
  }, []);
  return {state, copy};
}

function DockButton({
  label,
  tip,
  onClick,
  className,
  children,
  expanded,
  controls,
  disabled,
  badge,
  buttonRef,
}: {
  label: string;
  tip?: string;
  onClick(event: MouseEvent<HTMLButtonElement>): void;
  className?: string;
  children: ReactNode;
  expanded?: boolean;
  controls?: string;
  disabled?: boolean;
  badge?: ReactNode;
  buttonRef?: {current: HTMLButtonElement | null};
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={clsx(s.btn, className)}
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={expanded ? controls : undefined}
      data-tip={tip ?? label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
      {badge}
    </button>
  );
}

type CallProps = {
  call: CallState;
  code: string;
  invite: string;
  name: string;
  onRename(name: string): void;
  devices: DeviceChoice;
  onDevices(next: DeviceChoice): void;
  onLeave(): void;
};

/** The room itself: a dark stage with the video grid, a control dock and side panels. */
export default function Call({call, code, invite, name, onRename, devices, onDevices, onLeave}: CallProps) {
  const [panel, setPanel] = useState<PanelKind | null>(null);
  const [deviceFocus, setDeviceFocus] = useState<{kind: 'audio' | 'video'; n: number}>({kind: 'audio', n: 0});
  const opener = useRef<HTMLElement | null>(null);
  const chatButton = useRef<HTMLButtonElement | null>(null);
  const [playback, setPlayback] = useState<Record<string, Playback>>({});
  const players = useRef(new Map<string, () => void>());
  const registerPlayer = useCallback((peer: string, play: (() => void) | null) => {
    if (play) players.current.set(peer, play);
    else players.current.delete(peer);
  }, []);
  const onPlayback = useCallback((peer: string, state: Playback) => {
    setPlayback((p) => (p[peer] === state ? p : {...p, [peer]: state}));
  }, []);
  const [seenChat, setSeenChat] = useState(0);
  const [toast, setToast] = useState<ChatLine | null>(null);
  const [announce, setAnnounce] = useState('');
  const now = useClock();

  const peerList = useMemo(() => Object.values(call.peers), [call.peers]);
  const local = call.room?.localStream ?? null;

  // Speaking rings: a level meter on every remote audio track and on your own microphone.
  const sources = useMemo(() => {
    const list: AudioSource[] = [];
    for (const [id, stream] of Object.entries(call.streams)) for (const track of stream.getAudioTracks()) list.push({key: id, track});
    const mine = local?.getAudioTracks()[0];
    if (mine) list.push({key: 'self', track: mine});
    return list;
    // localVersion changes whenever Freehop swaps a local track.
  }, [call.streams, local, call.localVersion]);
  const speaking = useSpeaking(sources, call.phase === 'live');

  // Layout: alone, you share the stage with the invite card; with one other person your own
  // view floats in a corner; with more, everyone shares the grid.
  const alone = peerList.length === 0;
  const pip = peerList.length === 1;
  const count = alone ? 2 : pip ? 1 : peerList.length + 1;
  const layout = useTileLayout(count, 12);
  // With one other person they fill the stage (capped for very wide screens) and your view floats on top.
  const size = pip ? {width: Math.floor(Math.min(layout.box.w, layout.box.h * 2.2)), height: Math.floor(layout.box.h)} : {width: layout.w, height: layout.h};

  // Focus returns to whatever opened a panel when it closes.
  const openPanel = useCallback((kind: PanelKind, from: HTMLElement | null) => {
    opener.current = from;
    setPanel((current) => (current === kind ? null : kind));
  }, []);
  const showDevices = useCallback((kind: 'audio' | 'video', from: HTMLElement) => {
    opener.current = from;
    setDeviceFocus((f) => ({kind, n: f.n + 1}));
    setPanel('devices');
  }, []);
  const restoreFocus = useRef(false);
  const closePanel = useCallback(() => {
    restoreFocus.current = true;
    setPanel(null);
  }, []);
  useLayoutEffect(() => {
    if (panel !== null || !restoreFocus.current) return;
    restoreFocus.current = false;
    opener.current?.focus();
  }, [panel]);

  const unread = call.chat.filter((line) => !line.mine && line.key > seenChat).length;
  const lastChat = call.chat[call.chat.length - 1];
  useEffect(() => {
    if (panel === 'chat' && lastChat) setSeenChat(lastChat.key);
  }, [panel, lastChat]);
  // A new message from someone else pops up briefly while the chat is closed; each only once.
  const toasted = useRef(0);
  useEffect(() => {
    if (!lastChat || lastChat.mine || lastChat.key <= toasted.current) return;
    toasted.current = lastChat.key;
    if (panel !== 'chat') setToast(lastChat);
  }, [lastChat, panel]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Spoken updates for screen reader users when people come and go.
  const known = useRef(new Map<string, string>());
  useEffect(() => {
    const before = known.current;
    const after = new Map(peerList.map((p) => [p.id, p.name ?? 'Someone']));
    const joined = [...after].filter(([id]) => !before.has(id)).map(([, n]) => n);
    const left = [...before].filter(([id]) => !after.has(id)).map(([, n]) => n);
    known.current = after;
    const parts = [...joined.map((n) => `${n} joined.`), ...left.map((n) => `${n} left.`)];
    if (parts.length) setAnnounce(parts.join(' '));
  }, [peerList]);

  const blocked = Object.entries(playback).some(([id, state]) => state === 'blocked' && call.peers[id]);

  // Panels and banners resize the stage: lay the tiles out again before the next paint.
  const measure = layout.measure;
  useLayoutEffect(() => {
    measure();
  }, [measure, panel, call.trackersDown, call.notice, blocked]);
  const enableSound = () => {
    // play() runs synchronously inside this click so the browser accepts it.
    for (const play of players.current.values()) play();
  };

  const peerStatus = (peer: Peer) =>
    peer.connected ? null : peer.path === 'unreachable' ? `Can't reach ${peer.name ?? 'them'} yet. Hopper keeps trying.` : 'Connecting…';

  const anyGate = Object.values(call.gates).some((state) => state === 'joined');

  return (
    <section className={s.stage} aria-label="Room">
      <header className={s.topbar}>
        <div className={s.brand}>
          <span className={s.markTile}>
            <HopperMark size={32} />
          </span>
          <span className={s.brandName}>Hopper</span>
        </div>
      </header>

      {(call.trackersDown || call.notice || blocked) && (
        <div className={s.banners}>
          {call.trackersDown && (
            <p className={clsx(s.banner, s.bannerWarn)} role="alert">
              Hopper can't reach the public trackers that introduce people, so nobody can find you yet. It keeps trying. A VPN, firewall or school network can
              block them.
            </p>
          )}
          {call.notice && (
            <p className={s.banner} role="status">
              <span>{call.notice}</span>
              <button type="button" className={s.bannerClose} onClick={() => call.setNotice(null)} aria-label="Dismiss this message">
                <CloseIcon width={18} height={18} />
              </button>
            </p>
          )}
          {blocked && (
            <p className={s.banner} role="alert">
              <span>Your browser paused the sound of this call.</span>
              <button type="button" className={s.bannerAction} onClick={enableSound}>
                Enable sound
              </button>
            </p>
          )}
        </div>
      )}

      <div className={s.body}>
        <div className={s.tilesArea} ref={layout.ref}>
          <div className={s.tiles}>
            {alone && <InviteCard style={size} code={code} invite={invite} lonely={call.lonely} reaching={!anyGate} />}
            {peerList.map((peer) => (
              <Tile
                key={peer.id}
                id={peer.id}
                name={peer.name ?? 'Guest'}
                stream={call.streams[peer.id] ?? null}
                camera={peer.cam !== false}
                mic={peer.mic}
                speaking={speaking.has(peer.id)}
                path={peer.path}
                via={peer.via}
                status={peerStatus(peer)}
                style={size}
              >
                {(playback[peer.id] === 'blocked' || playback[peer.id] === 'error') && (
                  <button type="button" className={s.soundButton} onClick={() => players.current.get(peer.id)?.()}>
                    {playback[peer.id] === 'blocked' ? 'Enable sound' : 'Retry sound'}
                  </button>
                )}
              </Tile>
            ))}
            <Tile
              key="self"
              id={call.room?.id ?? 'self'}
              name={name}
              self
              stream={local}
              camera={call.cam}
              mic={call.mic}
              speaking={speaking.has('self')}
              status={call.camBusy ? 'Starting camera…' : null}
              className={clsx(pip && s.pip)}
              style={pip ? undefined : size}
            />
          </div>
          {toast && panel !== 'chat' && (
            <button type="button" className={s.toast} onClick={() => openPanel('chat', chatButton.current)}>
              <strong>{call.peers[toast.from]?.name ?? toast.name}</strong>
              <span>{toast.text}</span>
            </button>
          )}
        </div>

        {panel && (
          <SidePanel kind={panel} onClose={closePanel}>
            {panel === 'people' && <PeoplePanel call={call} name={name} onRename={onRename} speaking={speaking} />}
            {panel === 'chat' && <ChatPanel call={call} />}
            {panel === 'info' && <InfoPanel code={code} invite={invite} gates={call.gates} />}
            {panel === 'devices' && <DevicesPanel call={call} devices={devices} onDevices={onDevices} focus={deviceFocus} />}
          </SidePanel>
        )}
      </div>

      <div className={s.dock}>
        <div className={s.dockInfo} aria-hidden="true">
          <time>{timeFormat.format(now)}</time>
          <span className={s.dockDivider} />
          <span>{code}</span>
        </div>
        <div className={s.controls} role="group" aria-label="Microphone, camera and leave">
          <div className={s.split}>
            <DockButton
              label="Choose a microphone"
              className={s.caret}
              expanded={panel === 'devices'}
              controls="hopper-panel"
              onClick={(e) => showDevices('audio', e.currentTarget)}
            >
              <CaretIcon width={18} height={18} />
            </DockButton>
            <DockButton
              label={call.mic ? 'Turn off microphone' : 'Turn on microphone'}
              className={clsx(!call.mic && s.btnOff)}
              onClick={() => void call.toggleMic()}
            >
              {call.mic ? <MicIcon /> : <MicOffIcon />}
            </DockButton>
          </div>
          <div className={s.split}>
            <DockButton
              label="Choose a camera"
              className={s.caret}
              expanded={panel === 'devices'}
              controls="hopper-panel"
              onClick={(e) => showDevices('video', e.currentTarget)}
            >
              <CaretIcon width={18} height={18} />
            </DockButton>
            <DockButton
              label={call.camBusy ? 'Starting camera' : call.cam ? 'Turn off camera' : 'Turn on camera'}
              className={clsx(!call.cam && s.btnOff)}
              disabled={call.camBusy}
              onClick={() => void call.toggleCam()}
            >
              {call.cam ? <CamIcon /> : <CamOffIcon />}
            </DockButton>
          </div>
          <DockButton label="Leave the room" tip="Leave" className={s.leave} onClick={onLeave}>
            <LeaveIcon width={26} height={26} />
          </DockButton>
        </div>
        <div className={s.side} role="group" aria-label="Room panels">
          <DockButton
            label="Room details"
            className={clsx(panel === 'info' && s.btnActive)}
            expanded={panel === 'info'}
            controls="hopper-panel"
            onClick={(e) => openPanel('info', e.currentTarget)}
          >
            <InfoIcon />
          </DockButton>
          <DockButton
            label={`People (${peerList.length + 1})`}
            tip="People"
            className={clsx(panel === 'people' && s.btnActive)}
            expanded={panel === 'people'}
            controls="hopper-panel"
            onClick={(e) => openPanel('people', e.currentTarget)}
            badge={
              <span className={s.count} aria-hidden="true">
                {peerList.length + 1}
              </span>
            }
          >
            <PeopleIcon />
          </DockButton>
          <DockButton
            label={unread ? `Chat (${unread} new)` : 'Chat'}
            tip="Chat"
            className={clsx(panel === 'chat' && s.btnActive)}
            expanded={panel === 'chat'}
            controls="hopper-panel"
            onClick={(e) => openPanel('chat', e.currentTarget)}
            buttonRef={chatButton}
            badge={unread > 0 ? <span className={s.unread} aria-hidden="true" /> : null}
          >
            <ChatIcon />
          </DockButton>
        </div>
      </div>

      <div hidden>
        {peerList.map((peer) => (
          <RemoteAudio
            key={peer.id}
            peer={peer.id}
            stream={call.streams[peer.id]}
            speaker={devices.speaker}
            onPlayback={onPlayback}
            register={registerPlayer}
          />
        ))}
      </div>
      <p className="fh-visually-hidden" aria-live="polite">
        {announce}
      </p>
    </section>
  );
}

function InviteCard({
  style,
  code,
  invite,
  lonely,
  reaching,
}: {
  style: {width: number; height: number};
  code: string;
  invite: string;
  lonely: boolean;
  reaching: boolean;
}) {
  const {state, copy} = useCopy();
  return (
    <div className={s.invite} style={style}>
      <svg className={s.inviteArt} viewBox="0 0 160 92" aria-hidden="true">
        <path d="M20 84 Q80 -6 140 84" fill="none" stroke="#5c5c5c" strokeWidth={4} strokeLinecap="round" strokeDasharray="0.1 11" />
        <g className={s.inviteHop}>
          <g transform="translate(80 52)">
            <HopperFigure scale={0.62} />
          </g>
        </g>
        <ellipse cx={80} cy={86} rx={18} ry={3.5} fill="#2b2b2b" className={s.inviteShadow} />
      </svg>
      <h2 className={s.inviteTitle}>{reaching ? 'Reaching the trackers…' : 'You are the first one here'}</h2>
      <p className={s.inviteText}>
        {lonely
          ? 'Still nobody. Check that the others opened this exact link. Two people on very strict networks may not reach each other without a gateway.'
          : 'Send this link to the people you want to meet. Anyone with the link can join.'}
      </p>
      <p className={s.inviteCode}>{code}</p>
      <button type="button" className={s.inviteCopy} onClick={() => void copy(invite)}>
        {state === 'copied' ? <CheckIcon width={20} height={20} /> : <CopyIcon width={20} height={20} />}
        {state === 'copied' ? 'Link copied' : state === 'failed' ? 'Copy failed: use Room details' : 'Copy joining link'}
      </button>
    </div>
  );
}

const PANEL_TITLE: Record<PanelKind, string> = {people: 'People', chat: 'In-call messages', info: 'Room details', devices: 'Audio and video'};

function SidePanel({kind, onClose, children}: {kind: PanelKind; onClose(): void; children: ReactNode}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // Chat and devices move focus to their own field; the others start at their heading.
    if (kind === 'people' || kind === 'info') heading.current?.focus();
  }, [kind]);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  };
  return (
    <aside id="hopper-panel" className={s.panel} aria-labelledby="hopper-panel-title" onKeyDown={onKeyDown}>
      <div className={s.panelHead}>
        <h2 id="hopper-panel-title" className={s.panelTitle} tabIndex={-1} ref={heading}>
          {PANEL_TITLE[kind]}
        </h2>
        <button type="button" className={s.panelClose} onClick={onClose} aria-label={`Close ${PANEL_TITLE[kind].toLowerCase()}`}>
          <CloseIcon width={20} height={20} />
        </button>
      </div>
      <div className={s.panelBody}>{children}</div>
    </aside>
  );
}

function PeoplePanel({call, name, onRename, speaking}: {call: CallState; name: string; onRename(name: string): void; speaking: ReadonlySet<string>}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);
  const save = (event: FormEvent) => {
    event.preventDefault();
    const clean = cleanName(draft);
    if (clean) onRename(clean);
    setEditing(false);
    window.setTimeout(() => editButton.current?.focus(), 0);
  };
  const peers = Object.values(call.peers);
  return (
    <>
      <p className={s.panelLead}>In this room: {peers.length + 1}</p>
      <ul className={s.people}>
        <li className={s.person}>
          <span className={clsx(s.miniAvatar, s[`tone_${avatarTone(call.room?.id ?? 'self')}`])} aria-hidden="true">
            {initials(name)}
          </span>
          <span className={s.personMain}>
            {editing ? (
              <form className={s.renameForm} onSubmit={save}>
                <label className="fh-visually-hidden" htmlFor="hopper-rename">
                  Your name
                </label>
                <input
                  id="hopper-rename"
                  ref={input}
                  className={s.renameInput}
                  value={draft}
                  maxLength={NAME_MAX}
                  autoComplete="nickname"
                  onChange={(e) => setDraft(cleanName(e.target.value, {trim: false}))}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      setEditing(false);
                      setDraft(name);
                    }
                  }}
                />
                <button type="submit" className={s.smallPrimary} disabled={!cleanName(draft)}>
                  Save
                </button>
              </form>
            ) : (
              <>
                <span className={s.personName}>
                  {name} <span className={s.personYou}>(you)</span>
                </span>
                <button
                  type="button"
                  ref={editButton}
                  className={s.linkButton}
                  onClick={() => {
                    setDraft(name);
                    setEditing(true);
                  }}
                >
                  Rename
                </button>
              </>
            )}
          </span>
          <MicState on={call.mic} speaking={speaking.has('self')} />
        </li>
        {peers.map((peer) => (
          <li key={peer.id} className={s.person}>
            <span className={clsx(s.miniAvatar, s[`tone_${avatarTone(peer.id)}`])} aria-hidden="true">
              {initials(peer.name ?? 'Guest')}
            </span>
            <span className={s.personMain}>
              <span className={s.personName}>{peer.name ?? 'Guest'}</span>
              <PathBadge kind={peer.path} via={peer.via && peer.path !== 'direct' ? peer.via.slice(0, 6) : undefined} size="sm" />
            </span>
            <MicState on={peer.mic !== false} speaking={speaking.has(peer.id)} />
          </li>
        ))}
      </ul>
      {peers.length === 0 && <p className={s.panelHint}>Nobody else yet. Share the link from Room details.</p>}
    </>
  );
}

function MicState({on, speaking}: {on: boolean; speaking: boolean}) {
  return (
    <span className={clsx(s.micState, !on && s.micStateOff, on && speaking && s.micStateTalk)} title={on ? 'Microphone on' : 'Microphone off'}>
      {on ? <MicIcon width={18} height={18} /> : <MicOffIcon width={18} height={18} />}
      <span className="fh-visually-hidden">{on ? 'Microphone on' : 'Microphone off'}</span>
    </span>
  );
}

function ChatPanel({call}: {call: CallState}) {
  const [draft, setDraft] = useState('');
  const [blockedUntil, setBlockedUntil] = useState(0);
  const [, tick] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    box.current?.focus();
  }, []);
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [call.chat.length]);
  // A short cooldown after a burst of messages, counted down live.
  useEffect(() => {
    if (!blockedUntil) return;
    const timer = window.setInterval(() => {
      if (Date.now() >= blockedUntil) setBlockedUntil(0);
      else tick((n) => n + 1);
    }, 250);
    return () => window.clearInterval(timer);
  }, [blockedUntil]);
  const wait = blockedUntil ? Math.max(0, blockedUntil - Date.now()) : 0;
  const send = (event?: FormEvent) => {
    event?.preventDefault();
    if (!draft.trim()) return;
    const result = call.sendChat(draft);
    if (result.ok) {
      setDraft('');
      setBlockedUntil(0);
    } else if (result.waitMs > 0) setBlockedUntil(Date.now() + result.waitMs);
  };
  const lines = call.chat;
  return (
    <div className={s.chat}>
      <p className={s.chatNote}>Messages go straight to the people in this room. Nothing is stored, and they disappear when you leave.</p>
      <ol className={s.messages} ref={list} aria-live="polite" aria-label="Messages">
        {lines.length === 0 && <li className={s.noMessages}>No messages yet. Say hello.</li>}
        {lines.map((line, i) => {
          const previous = lines[i - 1];
          const grouped = previous && previous.from === line.from && line.at - previous.at < 120000;
          const who = line.mine ? 'You' : (call.peers[line.from]?.name ?? line.name);
          return (
            <li key={line.key} className={clsx(s.message, grouped && s.messageGrouped)} data-mine={line.mine ? 'true' : undefined}>
              {!grouped && (
                <p className={s.messageHead}>
                  <strong>{who}</strong>
                  <time dateTime={new Date(line.at).toISOString()}>{timeFormat.format(line.at)}</time>
                </p>
              )}
              <p className={s.messageText}>{line.text}</p>
            </li>
          );
        })}
      </ol>
      <form className={s.chatForm} onSubmit={send}>
        <label htmlFor="hopper-chat" className="fh-visually-hidden">
          Send a message to everyone
        </label>
        <textarea
          id="hopper-chat"
          ref={box}
          className={s.chatInput}
          value={draft}
          rows={2}
          maxLength={CHAT_MAX}
          placeholder="Send a message"
          onChange={(e) => setDraft(e.target.value.slice(0, CHAT_MAX))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button type="submit" className={s.sendButton} aria-label="Send message" disabled={!draft.trim() || wait > 0}>
          <SendIcon width={20} height={20} />
        </button>
      </form>
      <p className={s.chatMeta} role="status">
        {wait > 0
          ? `You are sending quickly. Try again in ${Math.ceil(wait / 1000)} s.`
          : draft.length > CHAT_MAX - 100
            ? `${draft.length} of ${CHAT_MAX} characters`
            : 'Enter sends, Shift + Enter adds a line.'}
      </p>
    </div>
  );
}

function InfoPanel({code, invite, gates}: {code: string; invite: string; gates: Record<string, string>}) {
  const {state, copy} = useCopy();
  return (
    <div className={s.info}>
      <h3 className={s.infoHeading}>Joining link</h3>
      <input className={s.linkField} readOnly value={invite} aria-label="Joining link" onFocus={(e) => e.currentTarget.select()} />
      <button type="button" className={s.primarySmall} onClick={() => void copy(invite)}>
        {state === 'copied' ? <CheckIcon width={18} height={18} /> : <CopyIcon width={18} height={18} />}
        {state === 'copied' ? 'Link copied' : state === 'failed' ? 'Copy failed: select the link above' : 'Copy joining link'}
      </button>
      <p className={s.infoCode}>
        Room code <code>{code}</code>
      </p>
      <h3 className={s.infoHeading}>How Hopper works</h3>
      <ol className={s.steps}>
        <li>
          <strong>Find each other.</strong> Your browsers meet through two public trackers. They pass sealed introductions and never see your audio or video.
        </li>
        <li>
          <strong>Connect.</strong> Freehop opens a link between the browsers: direct when it can, the next best path when networks get in the way.
        </li>
        <li>
          <strong>Talk.</strong> Audio, video and chat travel between the browsers in this room. No server of ours carries the call.
        </li>
      </ol>
      <h3 className={s.infoHeading}>Trackers</h3>
      <ul className={s.trackers}>
        {TRACKERS.map((url) => {
          const state = gates[url] ?? 'idle';
          return (
            <li key={url} className={clsx(s.tracker, s[`gate_${state}`])}>
              <span className={s.trackerDot} aria-hidden="true" />
              <span className={s.trackerName}>{trackerName(url)}</span>
              <span className={s.trackerState}>{GATE_STATE[state] ?? state}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DevicesPanel({
  call,
  devices,
  onDevices,
  focus,
}: {
  call: CallState;
  devices: DeviceChoice;
  onDevices(next: DeviceChoice): void;
  focus: {kind: 'audio' | 'video'; n: number};
}) {
  const [lists, setLists] = useState<DeviceLists>({audio: [], video: [], speaker: []});
  useEffect(() => {
    document.getElementById(focus.kind === 'audio' ? 'hopper-mic' : 'hopper-cam')?.focus();
  }, [focus]);
  useEffect(() => {
    let live = true;
    const refresh = () =>
      void listDevices().then((next) => {
        if (live) setLists(next);
      });
    refresh();
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
    return () => {
      live = false;
      navigator.mediaDevices?.removeEventListener?.('devicechange', refresh);
    };
  }, [call.localVersion]);
  const pick = (kind: 'audio' | 'video') => (event: ChangeEvent<HTMLSelectElement>) => {
    const id = event.target.value || null;
    onDevices({...devices, [kind]: id});
    void call.switchDevice(kind, id);
  };
  return (
    <div className={s.devices}>
      <DeviceSelect id="hopper-mic" label="Microphone" value={devices.audio} options={lists.audio} fallback="Microphone" onChange={pick('audio')} />
      <DeviceSelect id="hopper-cam" label="Camera" value={devices.video} options={lists.video} fallback="Camera" onChange={pick('video')} />
      {canPickSpeaker() && (
        <DeviceSelect
          id="hopper-speaker"
          label="Speaker"
          value={devices.speaker}
          options={lists.speaker}
          fallback="Speaker"
          onChange={(e) => onDevices({...devices, speaker: e.target.value || null})}
        />
      )}
      <p className={s.panelHint}>
        Hopper swaps the device in the running call without reconnecting anyone. A camera that is off starts with your choice next time.
      </p>
    </div>
  );
}

export function DeviceSelect({
  id,
  label,
  value,
  options,
  fallback,
  onChange,
  className,
}: {
  id: string;
  label: string;
  value: string | null;
  options: MediaDeviceInfo[];
  fallback: string;
  onChange(event: ChangeEvent<HTMLSelectElement>): void;
  className?: string;
}) {
  const known = !value || options.some((o) => o.deviceId === value);
  return (
    <label className={clsx(s.deviceField, className)} htmlFor={id}>
      <span className={s.deviceLabel}>{label}</span>
      <select id={id} className={s.deviceSelect} value={known ? (value ?? '') : ''} onChange={onChange}>
        <option value="">System default</option>
        {options
          .filter((o) => o.deviceId !== 'default')
          .map((o, i) => (
            <option key={o.deviceId} value={o.deviceId}>
              {o.label || `${fallback} ${i + 1}`}
            </option>
          ))}
      </select>
    </label>
  );
}
