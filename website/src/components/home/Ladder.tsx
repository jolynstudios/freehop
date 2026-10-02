import Link from '@docusaurus/Link';
import Section, {Chevron, Eyebrow, Title} from './Section';
import {BridgedPorthole, DirectPorthole, GatewayPorthole, RelayPorthole, UnreachablePorthole} from './Portholes';
import styles from './Ladder.module.css';

const STEPS = [
  {
    n: '1',
    name: 'Direct',
    when: 'Phase 0 · first 5 s',
    text: 'Home to home: same LAN, IPv6, or a NAT hole punched with STUN. Nothing in between.',
    art: <DirectPorthole />,
  },
  {
    n: '2',
    name: 'Gateway',
    when: 'Phase 0 · first 5 s',
    text: "A desktop player's own front door: a TURN gateway on their machine, reachable through a router port mapping.",
    art: <GatewayPorthole />,
  },
  {
    n: '3',
    name: 'Relay',
    when: 'Phase 1 · next 7 s',
    text: "Another session member's gateway carries it, such as the host node that runs the match.",
    art: <RelayPorthole />,
  },
  {
    n: '4',
    name: 'Bridged',
    when: 'Phase 2 · after that',
    text: 'A participant who reaches you both forwards the media. They are in the call anyway.',
    art: <BridgedPorthole />,
  },
  {
    n: '!',
    name: 'Unreachable',
    when: 'Retries · 30 s to 5 min',
    text: 'No route inside the session. Freehop says so plainly and retries, instead of renting a relay.',
    art: <UnreachablePorthole />,
  },
];

export default function Ladder() {
  return (
    <Section tone="yellow" labelledBy="how-it-works" className={styles.section}>
      <div className={styles.head}>
        <Eyebrow>How a call finds its way</Eyebrow>
        <Title id="how-it-works" className={styles.title}>
          Every pair takes the cheapest road that works.
        </Title>
        <p className={styles.lede}>
          Each pair of people climbs the same ladder and stops at the first rung that connects. Your servers are not on it:
          a byte of media only crosses machines that belong to the call.
        </p>
      </div>
      <ol className={styles.steps}>
        <svg className={styles.road} viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">
          <path
            d="M100 50 C 150 4, 250 4, 300 50 S 450 96, 500 50 S 650 4, 700 50 S 850 96, 900 50"
            fill="none"
            stroke="#333"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray="0.1 14"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {STEPS.map(step => (
          <li key={step.name} className={styles.step}>
            <div className={styles.art}>
              {step.art}
              <span className={styles.badge} aria-hidden="true">
                {step.n}
              </span>
            </div>
            <div className={styles.copy}>
              <h3 className={styles.name}>{step.name}</h3>
              <p className={styles.when}>{step.when}</p>
              <p className={styles.text}>{step.text}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className={styles.foot}>
        <Link className={styles.cta} to="/demos">
          <Chevron>Find the path for two networks</Chevron>
        </Link>
        <Link className={styles.ctaQuiet} to="/docs/concepts/paths">
          <Chevron>Read how escalation works</Chevron>
        </Link>
      </div>
    </Section>
  );
}
