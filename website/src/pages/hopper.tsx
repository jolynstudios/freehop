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

/** Hopper: a Meet(up)-like video meeting demo with Freehop as its engine. */
export default function HopperPage() {
  return (
    <Layout
      title="Hopper"
      description="Hopper is a Meet(up)-like video meeting demo built on Freehop. Start a meeting, share the link, and the browsers in it connect straight to each other.">
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
