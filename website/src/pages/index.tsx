import {useState} from 'react';
import Layout from '@theme/Layout';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import BrowserOnly from '@docusaurus/BrowserOnly';
import CodeBlock from '@theme/CodeBlock';
import AppShowcase from '@site/src/components/home/AppShowcase';
import UseCases from '@site/src/components/home/UseCases';
import CompareTable from '@site/src/components/compare/CompareTable';
import s from './index.module.css';
const snippet = `import { connect } from 'freehop';

const session = await connect(ticket, {
  media: { audio: true, video: false }
});

session.on('track', ({ peer, track }) => {
  session.attach(track, mediaElementFor(peer));
});

await session.send({ type: 'ready', ready: true });`;
export default function Home() {
  const [paused, setPaused] = useState(false);
  const [copy, setCopy] = useState('Copy');
  return (
    <Layout
      title="Voice and video, inside your app."
      description="An open-source calling SDK for small meeting rooms, in-app calls, shared workspaces and Electron apps. Your interface, with voice, video and session data."
    >
      <Head>
        <html className="fh-home" />
      </Head>
      <main>
        <section className={s.hero} aria-labelledby="hero-title">
          <div className={s.heroMedia}>
            <BrowserOnly>
              {() => {
                const Scene = require('@site/src/components/world/SignalField').default;
                return <Scene paused={paused} />;
              }}
            </BrowserOnly>
          </div>
          <div className={s.heroTop}>
            <span>
              Open-source connections.
              <br />
              For the apps you build.
            </span>
            <span>
              Browser / Desktop
              <br />
              JavaScript SDK · Alpha
            </span>
          </div>
          <div className={s.heroCopy}>
            <h1 id="hero-title">
              Voice and video,
              <br />
              inside your app.
            </h1>
            <div className={s.heroBottom}>
              <div>
                <p>
                  An open-source SDK for small rooms and in-app calls.
                  <br />
                  Browser or desktop. Your interface, your code.
                </p>
                <div className={s.actions}>
                  <Link className={s.primary} to="/demo">
                    Try a live call <span aria-hidden="true">↗</span>
                  </Link>
                  <Link className={s.textLink} to="/docs/quickstart">
                    Start building <span aria-hidden="true">→</span>
                  </Link>
                </div>
              </div>
              <div className={s.sceneControls}>
                <span>
                  Signal study.
                  <br />
                  Drag to explore.
                </span>
                <button
                  type="button"
                  aria-label={paused ? 'Play scene animation' : 'Pause scene animation'}
                  aria-pressed={paused}
                  onClick={() => setPaused((v) => !v)}
                >
                  {paused ? 'Play' : 'Pause'}
                </button>
              </div>
            </div>
          </div>
        </section>
        <section className={s.build} id="build">
          <div className={s.buildIntro}>
            <p className={s.label}>The Freehop SDK</p>
            <h2>
              One SDK.
              <br />
              Your interface.
            </h2>
            <p>
              Connect a session, attach incoming media to your own interface, and send small messages between participants. The same JavaScript API works in the
              browser and Electron.
            </p>
            <p>Control microphones, cameras and adaptive video. Your backend handles identity and session tickets; Freehop handles the connections.</p>
            <Link className={s.textLink} to="/docs/sdk/client">
              Explore the client API <span aria-hidden="true">→</span>
            </Link>
          </div>
          <div className={s.codeColumn}>
            <button
              className={s.install}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText('npm install freehop@alpha');
                  setCopy('Copied');
                } catch {
                  setCopy('Select to copy');
                }
              }}
            >
              <code>
                <span>$</span> npm install freehop@alpha
              </code>
              <span>{copy}</span>
            </button>
            <div className={s.code}>
              <div className={s.codeLabel}>
                <span>connect.js</span>
                <span>JavaScript</span>
              </div>
              <CodeBlock language="js">{snippet}</CodeBlock>
            </div>
            <p className={s.codeNote}>
              Your backend issues the ticket. Your app supplies the media elements. <Link to="/docs/quickstart">See the complete setup →</Link>
            </p>
          </div>
        </section>
        <UseCases />
        <AppShowcase />
        <section className={s.network}>
          <p className={s.label}>How the connection works</p>
          <h2>
            The shortest path
            <br />
            between people.
          </h2>
          <div className={s.path} aria-label="Connection fallback order">
            <span>Direct</span>
            <i>→</i>
            <span>Gateway</span>
            <i>→</i>
            <span>Relay</span>
            <i>→</i>
            <span>Bridged</span>
          </div>
          <div className={s.networkCopy}>
            <p>
              Direct when possible. Through a gateway or another participant in the session when needed. Signalling gates introduce the peers; they never carry
              media.
            </p>
            <p>
              If no session route works, Freehop reports <code>unreachable</code>. A host or gateway you run still uses your bandwidth.{' '}
              <Link to="/docs/concepts/paths">Understand the routes →</Link>
            </p>
          </div>
        </section>
        <section className={s.evidence}>
          <div className={s.evidenceHead}>
            <h2>
              Know what you’re
              <br />
              building on.
            </h2>
            <p>
              Alpha software, open evidence. Small rooms are the starting point. The published network results come from simulated home-lab tests; field
              reliability is still to be established.
            </p>
          </div>
          <CompareTable variant="home" />
          <div className={s.evidenceLinks}>
            <Link to="/docs/comparison">Full comparison and sources ↗</Link>
            <Link to="/docs/results">Test evidence ↗</Link>
            <Link to="/docs/limits">Current limits ↗</Link>
          </div>
        </section>
        <section className={s.closing}>
          <p className={s.label}>Apache-2.0 / No Freehop subscription</p>
          <h2>
            Build your
            <br />
            first call.
          </h2>
          <div className={s.actions}>
            <Link className={s.primary} to="/docs/quickstart">
              Build with Freehop <span aria-hidden="true">↗</span>
            </Link>
            <Link className={s.textLink} href="https://github.com/jolynstudios/freehop">
              View the source <span aria-hidden="true">↗</span>
            </Link>
          </div>
        </section>
      </main>
    </Layout>
  );
}
