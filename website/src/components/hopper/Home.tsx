import {useState, type FormEvent} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import HopperMark from './Mark';
import {HashIcon, LockIcon, NewMeetingIcon} from './Icons';
import {parseCode} from './code';
import s from './Hopper.module.css';

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

/** Start a room or join one with a code or link. */
export default function Home({notice, onNew, onJoin}: {notice: string | null; onNew(): void; onJoin(code: string): void}) {
  const [entry, setEntry] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const code = parseCode(entry);
    if (!code) {
      setError('That is not a Hopper room code. A code has four groups of five letters and digits, like k3m7q-x9fp2-h4wd8-c6tz0, or paste the whole link.');
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
              Your squad. <span className={s.titleLine}>One frequency.</span>
            </h1>
            <p className={s.homeLede}>
              Open a room for your next co-op run, build session, or community. Voice, video and chat in the browser. Share a link and bring your people.
            </p>
            {notice && (
              <p className={s.notice} role="alert">
                {notice}
              </p>
            )}
            <div className={s.homeActions}>
              <button type="button" className={s.primary} onClick={onNew}>
                <NewMeetingIcon />
                Create squad room
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
                    onChange={(e) => {
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
              No account required. Media travels between session participants.
            </p>
          </div>
        </div>
      </header>

      <section className={s.benefits} aria-labelledby="hopper-benefits-title">
        <div className={s.benefitsInner}>
          <p className={s.eyebrow}>BUILT WITH FREEHOP / OPEN TO REMIX</p>
          <h2 id="hopper-benefits-title" className={s.benefitsTitle}>
            Your platform starts here.
          </h2>
          <div className={s.benefitGrid}>
            <div className={s.benefit}>
              <h3>Spin up a squad.</h3>
              <p>Start a room and send the joining link. Your squad can join from their browser, with no sign-up.</p>
            </div>
            <div className={s.benefit}>
              <h3>Join your way.</h3>
              <p>Check your camera and microphone before you enter. Keep either one off, or join just to listen.</p>
            </div>
            <div className={s.benefit}>
              <h3>Keep comms in context.</h3>
              <p>See each other, talk, and share a message in the same room. Leave and rejoin whenever you need to.</p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
