import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import PageHeader from '@site/src/components/PageHeader';
import AppShowcase from '@site/src/components/home/AppShowcase';
import PathFinder from '@site/src/components/demos/PathFinder';
import EscalationTimeline from '@site/src/components/demos/EscalationTimeline';
import GateSees from '@site/src/components/demos/GateSees';
import CostCalculator from '@site/src/components/demos/CostCalculator';
import styles from './pages.module.css';

const DEMOS = [
  {
    id: 'path-finder',
    title: 'Path finder',
    text: 'Pick two networks and who else is in the call. See which rung of the ladder connects them, why, and what the home-lab tests measured.',
    Demo: PathFinder,
  },
  {
    id: 'escalation',
    title: 'Escalation timeline',
    text: "Step through the client's timers: when it tries the next rung, which servers it adds, and what happens when nothing works.",
    Demo: EscalationTimeline,
  },
  {
    id: 'gate',
    title: 'What the gate sees',
    text: "Seal a message with Freehop's own crypto, look at the exact frame a gate receives, then tamper with it.",
    Demo: GateSees,
  },
  {
    id: 'cost',
    title: 'Relay bill estimate',
    text: 'Compare a month of classic TURN relaying with the sealed signalling your gates carry. Every assumption is editable.',
    Demo: CostCalculator,
  },
];

export default function Demos() {
  return (
    <Layout
      title="Playground and network lab"
      description="See Freehop embedded in a live call, squad rooms and a browser game, then explore interactive networking demos."
    >
      <main>
        <PageHeader eyebrow="Built with Freehop" title="Play it. Remix it.">
          <p>
            Start with a Three.js co-op world, an orbital arena, a squad room, or the comms lab. Each is a working example of voice, video and data inside your
            own experience.
          </p>
          <Link to="/docs/quickstart">
            Build it into your app <span aria-hidden="true">&gt;</span>
          </Link>
        </PageHeader>
        <AppShowcase />
        <PageHeader eyebrow="NETWORK LAB" title="Understand the connection.">
          <p>These smaller tools use the SDK’s path rules and crypto to make the networking easier to inspect.</p>
          <nav className={styles.jump} aria-label="Demos on this page">
            {DEMOS.map((d) => (
              <a key={d.id} href={`#${d.id}`} className={styles.jumpLink}>
                {d.title}
              </a>
            ))}
          </nav>
        </PageHeader>
        <div className={styles.container}>
          {DEMOS.map(({id, title, text, Demo}) => (
            <section key={id} id={id} className={styles.demo} aria-labelledby={`${id}-title`}>
              <div className={styles.demoHead}>
                <h2 id={`${id}-title`} className={styles.demoTitle}>
                  {title}
                </h2>
                <p className={styles.demoText}>{text}</p>
              </div>
              <Demo />
            </section>
          ))}
        </div>
      </main>
    </Layout>
  );
}
