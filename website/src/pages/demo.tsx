import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Link from '@docusaurus/Link';
import PageHeader from '@site/src/components/PageHeader';
import {CallArt} from '@site/src/components/home/HeaderScenes';
import styles from './pages.module.css';

export default function Demo() {
  return (
    <Layout
      title="Live call"
      description="A real Freehop call in your browser. Two public WebTorrent trackers act as gates; the media goes straight between the people in the call.">
      <main>
        <PageHeader eyebrow="Live demo" title="A real call. No server of ours." art={<CallArt />}>
          <p>
            This page runs Freehop's own browser client. Two public WebTorrent trackers act as the gates and public STUN servers help
            each browser find its address. The audio and video go straight between you and the people you invite.
          </p>
        </PageHeader>
        <div className={styles.container}>
          <BrowserOnly fallback={<p className={styles.loading}>Loading the call…</p>}>
            {() => {
              const LiveCall = require('@site/src/components/demos/LiveCall').default;
              return <LiveCall />;
            }}
          </BrowserOnly>

          <div className={styles.notes}>
            <section>
              <h2 className={styles.noteTitle}>What to expect</h2>
              <ul>
                <li>The room code sits in the link after the # sign. Browsers never send that part to a web server.</li>
                <li>The code is the room secret: anyone with the link can join, so share it only with people you want in the call.</li>
                <li>Up to 8 people can join one room. Each pair shows the path it took: direct, gateway, relay, bridged or unreachable.</li>
                <li>Without desktop gateways or a host node in this room, two browsers behind strict NATs or UDP-blocking networks may stay unreachable. That is the honest boundary of a browser-only call.</li>
              </ul>
            </section>
            <section>
              <h2 className={styles.noteTitle}>Privacy and availability</h2>
              <ul>
                <li>As in any WebRTC call, the people in the call learn each other's IP addresses.</li>
                <li>
                  The public trackers (<code>tracker.openwebtorrent.com</code> and <code>tracker.webtorrent.dev</code>) and the STUN servers
                  are run by third parties. They see connection metadata, never your media. Freehop seals every signalling message so the
                  trackers cannot read it.
                </li>
                <li>Public trackers can be slow, full or unreachable from some networks. When they are, peers cannot find each other.</li>
                <li>
                  Freehop is alpha software, provided as is, without warranty of any kind. You use it at your own risk.{' '}
                  <Link to="/docs/license">License and disclaimer</Link>.
                </li>
              </ul>
            </section>
          </div>
        </div>
      </main>
    </Layout>
  );
}
