import {useState, type FormEvent} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import CodeBlock from '@theme/CodeBlock';
import HopperMark from './Mark';
import HopperArt from './HopperArt';
import {HashIcon, LockIcon, NewMeetingIcon} from './Icons';
import {parseCode} from './code';
import s from './Hopper.module.css';

const ENGINE = `import { join } from 'freehop/client';

const room = await join({
  gates: ['bt+wss://tracker.openwebtorrent.com', 'bt+wss://tracker.webtorrent.dev'],
  stun: PUBLIC_STUN,     // the live demo's public STUN servers
  secret: meetingCode,   // the part of the link after #
  app: 'hopper',
  media: { audio: true, video: false },
});

await room.setCamera(true);
room.on('track', ({ peer, track }) => showOnTile(peer, track));
room.on('message', ({ from, data }) => readHello(from, data));
room.send({ type: 'hello', name: 'Mila' });`;

/** The lockup used on Hopper's own screens. */
export function Lockup({className}: {className?: string}) {
  return (
    <p className={clsx(s.lockup, className)}>
      <HopperMark size={52} />
      <span className={s.lockupName}>Hopper</span>
      <span className={s.lockupBy}>
        by <Link to="/">Freehop</Link>
      </span>
    </p>
  );
}

/** Start a meeting or join one with a code or link. */
export default function Home({notice, onNew, onJoin}: {notice: string | null; onNew(): void; onJoin(code: string): void}) {
  const [entry, setEntry] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const code = parseCode(entry);
    if (!code) {
      setError('That is not a Hopper meeting code. A code has four groups of five letters and digits, like k3m7q-x9fp2-h4wd8-c6tz0, or paste the whole link.');
      return;
    }
    setError(null);
    onJoin(code);
  };
  return (
    <>
      <header className={s.scene}>
        <div className={s.homeInner}>
          <div className={s.homeCopy}>
            <Lockup />
            <h1 className={s.homeTitle}>
              Face to face, <span className={s.titleLine}>browser to browser.</span>
            </h1>
            <p className={s.homeLede}>
              Start a video meeting, share the link and talk. <strong>Hopper is a Meet(up)-like demo built on Freehop</strong>, so the
              browsers in your meeting connect straight to each other.
            </p>
            {notice && (
              <p className={s.notice} role="alert">
                {notice}
              </p>
            )}
            <div className={s.homeActions}>
              <button type="button" className={s.primary} onClick={onNew}>
                <NewMeetingIcon />
                New meeting
              </button>
              <form className={s.joinForm} onSubmit={submit} noValidate>
                <label htmlFor="hopper-code" className="fh-visually-hidden">
                  Enter a code or link
                </label>
                <span className={s.codeField}>
                  <HashIcon className={s.codeFieldIcon} />
                  <input
                    id="hopper-code"
                    className={s.codeInput}
                    value={entry}
                    maxLength={300}
                    placeholder="Enter a code or link"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? 'hopper-code-error' : undefined}
                    onChange={e => {
                      setEntry(e.target.value);
                      if (error) setError(null);
                    }}
                  />
                </span>
                <button type="submit" className={s.joinButton} disabled={!entry.trim()}>
                  Join
                </button>
              </form>
            </div>
            {error && (
              <p id="hopper-code-error" className={s.fieldError} role="alert">
                {error}
              </p>
            )}
            <p className={s.privacy}>
              <LockIcon width={18} height={18} />
              No sign-up, no server of ours carries your call.
            </p>
          </div>
          <div className={s.homeArt}>
            <HopperArt />
          </div>
        </div>
      </header>

      <section className={s.engine} aria-labelledby="hopper-engine-title">
        <div className={s.engineInner}>
          <div className={s.engineCopy}>
            <p className={s.eyebrow}>Powered by Freehop</p>
            <h2 id="hopper-engine-title" className={s.engineTitle}>
              The whole engine is one call.
            </h2>
            <p className={s.engineText}>
              Hopper is a small React layer over Freehop&apos;s browser client. <code>join()</code> finds the others, connects the browsers and
              hands Hopper their audio and video. Names, chat, mute and camera states travel as small sealed messages with{' '}
              <code>room.send()</code>.
            </p>
            <ol className={s.engineSteps}>
              <li>
                <strong>Find each other.</strong> Two public WebTorrent trackers pass sealed introductions. They never see audio or video.
              </li>
              <li>
                <strong>Connect.</strong> Freehop links the browsers directly when it can and picks the next best path when networks get
                in the way.
              </li>
              <li>
                <strong>Talk.</strong> Audio, video and chat travel between the browsers in the meeting.
              </li>
            </ol>
            <p className={s.engineLinks}>
              <Link className={s.engineLink} to="/docs">
                Read the Freehop docs <span aria-hidden="true">&gt;</span>
              </Link>
              <Link to="/docs/sdk/client">Client SDK</Link>
              <Link to="/docs/concepts/paths">How paths work</Link>
              <Link to="/demo">The simpler live call</Link>
            </p>
          </div>
          <div className={s.engineCode}>
            <CodeBlock language="js" title="hopper.js">
              {ENGINE}
            </CodeBlock>
          </div>
        </div>
      </section>
    </>
  );
}
