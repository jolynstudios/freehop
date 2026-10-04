import Link from '@docusaurus/Link';
import Section, {Eyebrow, Title} from './Section';
import HopperMark from '../hopper/Mark';
import styles from './AppShowcase.module.css';

function LiveArt() {
  return <div className={`${styles.art} ${styles.liveArt}`} aria-hidden="true"><span>you</span><i>↔</i><span>them</span><b>VOICE · VIDEO</b></div>;
}

function HopperArt() {
  return <div className={`${styles.art} ${styles.hopperArt}`} aria-hidden="true"><HopperMark size={76} /><span>Hopper</span></div>;
}

function MazeArt() {
  return <div className={`${styles.art} ${styles.mazeArt}`} aria-hidden="true">
    <div className={styles.mazeBoard}>
      <span /><span className={styles.wall} /><span /><span /><span className={styles.wall} /><span />
      <span className={styles.wall} /><span /><span /><span className={styles.wall} /><span />
      <span /><span className={styles.wall} /><span /><span /><span /><span className={styles.exit}>⌂</span>
    </div>
    <b>CALL OVERLAY INSIDE A GAME</b>
  </div>;
}

const examples = [
  {title: 'Live call', text: 'A real browser-to-browser call. See the media path and how little the signalling trackers carry.', to: '/demo', Art: LiveArt, link: 'Try it with a friend'},
  {title: 'Hopper', text: 'A small meeting app built on Freehop. Room links, device controls, chat and a live call in one browser experience.', to: '/hopper', Art: HopperArt, link: 'Open Hopper'},
  {title: 'Maze call', text: 'A tiny multiplayer maze with voice, optional video and live quality controls layered into the game.', to: '/maze', Art: MazeArt, link: 'Play the demo'},
];

/** A developer-first bridge from SDK to things people can actually build. */
export default function AppShowcase() {
  return (
    <Section tone="yellow" labelledBy="apps-built-on-freehop" className={styles.section}>
      <div className={styles.heading}>
        <div><Eyebrow>For developers</Eyebrow><Title id="apps-built-on-freehop" className={styles.title}>Put the call inside your app.</Title></div>
        <p>Add it to a game lobby, a shared workspace or any app where people need to talk. Keep your own interface, users and room flow.</p>
      </div>
      <div className={styles.codeRow}>
        <code>{'const call = await connect(ticket, { media: { audio: true }, adaptiveVideo: true });'}</code>
        <Link to="/docs/quickstart">Read the quickstart <span aria-hidden="true">&gt;</span></Link>
      </div>
      <div className={styles.cards}>
        {examples.map(({title, text, to, Art, link}) => (
          <Link key={title} to={to} className={styles.card}>
            <Art />
            <div className={styles.cardCopy}><h3>{title}</h3><p>{text}</p><span>{link} <span aria-hidden="true">&gt;</span></span></div>
          </Link>
        ))}
      </div>
    </Section>
  );
}
