import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import HopperMark from '@site/src/components/hopper/Mark';
import styles from '@site/src/components/hopper/Hopper.module.css';

function Loading() {
  return (
    <div className={styles.loading}>
      <HopperMark size={72} />
      <p>Loading Hopper…</p>
    </div>
  );
}

/** Hopper's meeting home, waiting room, and call. */
export default function HopperPage() {
  return (
    <Layout title="Hopper · Squad comms" description="Your squad, one frequency. Open a Freehop room for voice, video and chat in the browser.">
      <main className={styles.page}>
        <BrowserOnly fallback={<Loading />}>
          {() => {
            const Hopper = require('@site/src/components/hopper/Hopper').default;
            return <Hopper />;
          }}
        </BrowserOnly>
      </main>
    </Layout>
  );
}
