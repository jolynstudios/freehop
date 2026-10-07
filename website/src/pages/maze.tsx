import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import PageHeader from '@site/src/components/PageHeader';
import styles from './pages.module.css';

export default function MazePage() {
  return (
    <Layout
      title="Signal Run · Three.js co-op"
      description="A Three.js multiplayer browser maze with Freehop voice, video and adaptive quality controls built into the game."
    >
      <main>
        <PageHeader eyebrow="THREE.JS / FREEHOP / CO-OP" title="Signal Run.">
          <p>
            Find the exit in a 3D maze. Bring your squad into the same world with shared movement, voice and video. Play solo immediately, or join the room and
            share an invite.
          </p>
        </PageHeader>
        <BrowserOnly
          fallback={
            <div className={styles.container}>
              <p className={styles.loading}>Loading the game…</p>
            </div>
          }
        >
          {() => {
            const MazeGame = require('@site/src/components/demos/MazeGame').default;
            return <MazeGame />;
          }}
        </BrowserOnly>
        <div className={styles.container}>
          <div className={styles.notes}>
            <section>
              <h2 className={styles.noteTitle}>How to try it</h2>
              <ul>
                <li>Open the invite link on another browser or device to join the same room.</li>
                <li>Use the arrow keys or WASD to move. Positions are shared through Freehop’s encrypted room messages.</li>
                <li>The mic and camera start off. Turn either on from the call panel; adaptive video is on for this demo.</li>
              </ul>
            </section>
            <section>
              <h2 className={styles.noteTitle}>A live network demo</h2>
              <ul>
                <li>This static page uses public WebTorrent trackers and public STUN servers; they see connection metadata, not the media.</li>
                <li>Direct connections can expose network addresses to other participants. Anyone with the invite link can join the room.</li>
                <li>Freehop is alpha software. Network quality adapts when the browser reports sustained congestion; results vary by browser and network.</li>
              </ul>
            </section>
          </div>
        </div>
      </main>
    </Layout>
  );
}
