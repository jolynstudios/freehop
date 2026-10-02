import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import PageHeader from '@site/src/components/PageHeader';
import {DemosArt} from '@site/src/components/home/HeaderScenes';
import PathFinder from '@site/src/components/demos/PathFinder';
import EscalationTimeline from '@site/src/components/demos/EscalationTimeline';
import GateSees from '@site/src/components/demos/GateSees';
import CostCalculator from '@site/src/components/demos/CostCalculator';
import styles from './pages.module.css';

const DEMOS = [
  {id: 'path-finder', title: 'Path finder', text: 'Pick two networks and who else is in the call. See which rung of the ladder connects them, why, and what the lab measured.', Demo: PathFinder},
  {id: 'escalation', title: 'Escalation timeline', text: "Step through the client's timers: when it tries the next rung, which servers it adds, and what happens when nothing works.", Demo: EscalationTimeline},
  {id: 'gate', title: 'What the gate sees', text: "Seal a message with Freehop's own crypto, look at the exact frame a gate receives, then tamper with it.", Demo: GateSees},
  {id: 'cost', title: 'Relay bill estimate', text: 'Compare a month of classic TURN relaying with the sealed signalling your gates carry. Every assumption is editable.', Demo: CostCalculator},
];

export default function Demos() {
  return (
    <Layout title="Interactive demos" description="Play with Freehop's path ladder, its escalation timers, the gate's view of sealed envelopes and a relay cost estimate.">
      <main>
        <PageHeader eyebrow="Interactive demos" title="Play with the path ladder." art={<DemosArt />}>
          <p>Four small tools that run in this page, built on the same rules and the same crypto as the SDK.</p>
          <nav className={styles.jump} aria-label="Demos on this page">
            {DEMOS.map(d => (
              <a key={d.id} href={`#${d.id}`} className={styles.jumpLink}>
                {d.title}
              </a>
            ))}
            <Link to="/demo" className={styles.jumpLive}>
              Live call <span aria-hidden="true">&gt;</span>
            </Link>
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
