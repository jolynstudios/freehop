import Link from '@docusaurus/Link';
import {CostScene} from '../scenes';
import Section, {Chevron, Eyebrow, Title} from './Section';
import styles from './Problem.module.css';

export default function Problem() {
  return (
    <Section tone="paper" labelledBy="problem">
      <Eyebrow>Why Freehop exists</Eyebrow>
      <Title id="problem" className={styles.title}>
        Somebody pays for every relayed minute.
      </Title>
      <div className={styles.grid}>
        <div className={styles.copy}>
          <p className={styles.lede}>
            Peer-to-peer WebRTC tries to connect people directly. When that fails, a typical app falls back to a TURN relay: a rented server in the middle that receives
            every packet and sends it on. Whoever runs that relay pays for the traffic, for as long as each call lasts.
          </p>
          <p className={styles.body}>
            Freehop removes the rented middle. When a direct route fails, the media goes through a machine that already belongs
            to the call. Your servers only introduce people, with sealed envelopes of a few dozen kilobytes.
          </p>
          <p className={styles.body}>
            Freehop itself has no subscription or per-minute fee. Hosting your own gate, backend or session gateway can still
            cost money; the cost model explains which traffic those services carry.
          </p>
          <Link className={styles.link} to="/docs/concepts/cost">
            <Chevron>Read the cost model</Chevron>
          </Link>
        </div>
        <div className={styles.art}>
          <CostScene caption="A rented relay sits in the middle of the call. A gate only handles the envelopes." />
        </div>
      </div>
    </Section>
  );
}
