import Link from '@docusaurus/Link';
import {GateScene} from '../scenes';
import Section, {Chevron, Eyebrow, Title} from './Section';
import styles from './YourCost.module.css';

const FACTS = [
  {
    value: '0 GB',
    label: 'audio and video through your servers',
    note: 'Media goes between the people in the call. It never passes through your servers.',
  },
  {
    value: '15–35 KB',
    label: 'per pair of people, once per call',
    note: 'Sealed signalling through your gate while a call sets up, measured in home-lab network tests. Then only small keepalives.',
  },
  {
    value: '1 gate',
    label: 'is all you run',
    note: 'A small Node.js service with one dependency, on any small server. Or none: public torrent trackers can be your gates.',
  },
];

/** What Freehop costs the operator: signalling only, no media. */
export default function YourCost() {
  return (
    <Section tone="paper" labelledBy="cost">
      <div className={styles.head}>
        <div>
          <Eyebrow>Your bill</Eyebrow>
          <Title id="cost">What Freehop costs you.</Title>
        </div>
        <p className={styles.lede}>
          Your servers only introduce people. That work grows with the number of calls, not with how long they last or how sharp
          the video is.
        </p>
      </div>

      <div className={styles.body}>
        <ul className={styles.facts}>
          {FACTS.map(fact => (
            <li key={fact.label} className={styles.fact}>
              <span className={styles.value}>{fact.value}</span>
              <span className={styles.text}>
                <span className={styles.label}>{fact.label}</span>
                <span className={styles.note}>{fact.note}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className={styles.art}>
          <GateScene caption="Your gate is a mailbox: a few sealed envelopes per call, then quiet." />
        </div>
      </div>

      <div className={styles.example}>
        <p className={styles.exampleText}>
          <strong>Example.</strong> 1,000 calls a day between two people is 30,000 calls a month. At up to 35 KB per call setup,
          your gate passes about <strong>1 GB a month</strong>, plus small keepalives. Audio and video through your servers:{' '}
          <strong>0 GB</strong>, whether calls last five minutes or five hours.
        </p>
      </div>

      <div className={styles.foot}>
        <p className={styles.honest}>
          Calls that cannot connect directly still need a route. A participant&apos;s desktop gateway, the host node or a
          forwarding participant carries them: upload inside the session, not a line on your bill.
        </p>
        <Link className={styles.more} to="/docs/concepts/cost">
          <Chevron>Compare with a classic relay bill</Chevron>
        </Link>
      </div>
    </Section>
  );
}
