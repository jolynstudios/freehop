import Link from '@docusaurus/Link';
import CompareTable from '../compare/CompareTable';
import Section, {Chevron, Eyebrow, Title} from './Section';
import styles from './Compare.module.css';

export default function Compare() {
  return (
    <Section tone="paper" labelledBy="compare">
      <div className={styles.head}>
        <div>
          <Eyebrow>How it compares</Eyebrow>
          <Title id="compare">Same call. Different bill.</Title>
        </div>
        <p className={styles.lede}>
          Every option here can put people in a call. What differs is where the audio and video go when two people cannot connect
          directly, and who pays for that traffic.
        </p>
      </div>
      <CompareTable variant="home" />
      <div className={styles.foot}>
        <p className={styles.note}>
          Freehop is not the answer to everything. For meetings with dozens of people, recording or livestreams, an SFU such as
          LiveKit or Jitsi is the right tool.
        </p>
        <Link className={styles.more} to="/docs/comparison">
          <Chevron>Full comparison, with sources</Chevron>
        </Link>
      </div>
    </Section>
  );
}
