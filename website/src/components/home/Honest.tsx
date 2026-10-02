import Link from '@docusaurus/Link';
import {UnreachableScene} from '../scenes';
import Section, {Chevron, Eyebrow, Title} from './Section';
import styles from './Honest.module.css';

export default function Honest() {
  return (
    <Section tone="paper" labelledBy="limits">
      <div className={styles.grid}>
        <div className={styles.limits}>
          <Eyebrow>Honest limits</Eyebrow>
          <Title id="limits" className={styles.title}>
            Some networks only open the mail slot.
          </Title>
          <UnreachableScene />
          <p className={styles.text}>
            A network that lets nothing out except a connection to the gate cannot carry media unless the operator carries it. Freehop
            will not do that. It reports <code>unreachable</code>, keeps the call's other pairs running, and retries quietly.
          </p>
          <p className={styles.text}>
            Two browser-only participants who are both behind hard NATs or UDP-blocking networks, with nobody else in the session, cannot
            connect either. Add a desktop participant, a host node or a third participant and they can.
          </p>
          <Link className={styles.link} to="/docs/limits">
            <Chevron>Read every known limit</Chevron>
          </Link>
        </div>
        <aside className={styles.license} aria-labelledby="license-title">
          <h3 id="license-title" className={styles.licenseTitle}>
            Open source, no warranty
          </h3>
          <dl className={styles.terms}>
            <div>
              <dt>Code</dt>
              <dd>Apache-2.0</dd>
            </div>
            <div>
              <dt>Docs and protocol specification</dt>
              <dd>CC BY 4.0</dd>
            </div>
            <div>
              <dt>Copyright</dt>
              <dd>© 2026 Jolyn Studios</dd>
            </div>
          </dl>
          <p className={styles.warranty}>Freehop is provided as is, without warranty of any kind. You use it at your own risk.</p>
          <p className={styles.small}>
            It is alpha networking software: test it on your own networks, and remember that, as in any WebRTC call, the people in a
            call learn each other's IP addresses.
          </p>
          <Link className={styles.link} to="/docs/license">
            <Chevron>License and disclaimer</Chevron>
          </Link>
        </aside>
      </div>
    </Section>
  );
}
