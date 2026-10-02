import Link from '@docusaurus/Link';
import {CostScene} from '../scenes';
import Section, {Chevron, Eyebrow, Title} from './Section';
import styles from './Problem.module.css';

const STATS = [
  {
    value: '22%',
    label: 'of WebRTC conferences needed a TURN relay',
    source: 'callstats.io, 2015 to 2016',
    href: 'https://webrtchacks.com/usage-stats/',
  },
  {
    value: '17.7%',
    label: 'of appear.in peer-to-peer calls were relayed',
    source: 'appear.in data, 2017',
    href: 'https://medium.com/@fippo/what-kind-of-turn-server-is-being-used-d67dbfc2ff5d',
  },
  {
    value: '$0.05',
    unit: '/GB',
    label: 'list price for relayed traffic delivered to the client',
    source: 'Cloudflare Realtime TURN, an example rate',
    href: 'https://developers.cloudflare.com/realtime/turn/',
  },
];

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
          <Link className={styles.link} to="/docs/concepts/cost">
            <Chevron>Read the cost model</Chevron>
          </Link>
        </div>
        <div className={styles.art}>
          <CostScene caption="A rented relay sits in the middle of the call. A gate only handles the envelopes." />
        </div>
      </div>
      <ul className={styles.stats}>
        {STATS.map(stat => (
          <li key={stat.value} className={styles.stat}>
            <p className={styles.value}>
              {stat.value}
              {stat.unit && <span className={styles.unit}>{stat.unit}</span>}
            </p>
            <p className={styles.label}>{stat.label}</p>
            <a className={styles.source} href={stat.href} target="_blank" rel="noopener noreferrer">
              {stat.source}
            </a>
          </li>
        ))}
      </ul>
    </Section>
  );
}
