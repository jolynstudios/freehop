import Link from '@docusaurus/Link';
import s from './AppShowcase.module.css';
export default function AppShowcase({compact = false}: {compact?: boolean}) {
  const Heading = compact ? 'h2' : 'h3';
  return (
    <section
      className={`${s.section} ${compact ? s.compact : ''}`}
      aria-labelledby={compact ? undefined : 'demos-title'}
      aria-label={compact ? 'Calling demos' : undefined}
    >
      {!compact && (
        <div className={s.heading}>
          <p>Built with Freehop</p>
          <h2 id="demos-title">Try it in a call.</h2>
          <span>
            Open two browsers or invite someone.
            <br />
            See the SDK connect real people.
          </span>
        </div>
      )}
      <div className={s.more}>
        <Link to="/hopper">
          <span>Hopper</span>
          <Heading>A complete calling app.</Heading>
          <p>Preview your camera and microphone, share a room link, and talk with video, voice and chat.</p>
          <b>Open Hopper ↗</b>
        </Link>
        <Link to="/demo">
          <span>Live demo</span>
          <Heading>Inspect the connection.</Heading>
          <p>Start a real call and watch the connection path, media playback and session activity.</p>
          <b>Open the live demo ↗</b>
        </Link>
      </div>
    </section>
  );
}
