import Link from '@docusaurus/Link';
import BrowserOnly from '@docusaurus/BrowserOnly';
import s from './AppShowcase.module.css';
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
function Preview({orbital = false}: {orbital?: boolean}) {
  return (
    <BrowserOnly fallback={<div className={s.fallback} />}>
      {() => {
        const World = require('../world/WorldView').default;
        return <World walls={orbital ? ARENA : MAZE} orbital={orbital} preview goal={orbital ? {x: 7, y: 4} : {x: 13, y: 7}} />;
      }}
    </BrowserOnly>
  );
}
export default function AppShowcase() {
  return (
    <section className={s.section} aria-labelledby="playground-title">
      <div className={s.heading}>
        <p>Made with Freehop</p>
        <h2 id="playground-title">
          Come in.
          <br />
          Bring someone.
        </h2>
        <span>
          Working examples. Open source.
          <br />
          Play, inspect, make them yours.
        </span>
      </div>
      <div className={s.feature}>
        <div className={s.media}>
          <Preview />
          <div className={s.mediaLabel}>
            <span>Signal Run / Three.js</span>
            <span>Rendered game preview</span>
          </div>
        </div>
        <div className={s.detail}>
          <div>
            <p className={s.type}>Co-op maze</p>
            <h3>
              Find a way.
              <br />
              Talk it through.
            </h3>
          </div>
          <div>
            <p>A shared maze with voice and video beside the world. Explore alone, or send a room link to your squad and find the exit together.</p>
            <Link to="/maze">
              Play Signal Run <span aria-hidden="true">↗</span>
            </Link>
            <Link to="/docs/games" className={s.source}>
              How it’s built →
            </Link>
          </div>
        </div>
      </div>
      <div className={`${s.feature} ${s.second}`}>
        <div className={s.media}>
          <Preview orbital />
          <div className={s.mediaLabel}>
            <span>Orbital / Three.js</span>
            <span>Rendered game preview</span>
          </div>
        </div>
        <div className={s.detail}>
          <div>
            <p className={s.type}>Shared arena</p>
            <h3>
              Same space.
              <br />
              Different trajectories.
            </h3>
          </div>
          <div>
            <p>Collect signal beacons while other players move through the arena. Your score is local; movement, voice and video connect through Freehop.</p>
            <Link to="/orbital">
              Launch Orbital <span aria-hidden="true">↗</span>
            </Link>
            <Link to="/docs/sdk/client" className={s.source}>
              Explore the API →
            </Link>
          </div>
        </div>
      </div>
      <div className={s.more}>
        <Link to="/hopper">
          <span>Hopper</span>
          <h3>A room for your squad.</h3>
          <p>
            Camera preview, device controls and chat.
            <br />A calling experience you can make your own.
          </p>
          <b>Open Hopper ↗</b>
        </Link>
        <Link to="/demo">
          <span>Comms lab</span>
          <h3>See the connection happen.</h3>
          <p>
            A live call with path and playback inspection.
            <br />
            Understand what the SDK is doing.
          </p>
          <b>Open the lab ↗</b>
        </Link>
      </div>
    </section>
  );
}
