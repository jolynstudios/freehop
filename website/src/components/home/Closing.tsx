import Link from '@docusaurus/Link';
import CostCalculator from '../demos/CostCalculator';
import {C, HopArc, Mover, PaperPlane, arc, useMotionAllowed} from '../illustrations';
import Section, {Chevron, Eyebrow, Title} from './Section';
import styles from './Closing.module.css';

export function CostSection() {
  return (
    <Section tone="paper" labelledBy="cost">
      <div className={styles.costHead}>
        <div>
          <Eyebrow>Your bill</Eyebrow>
          <Title id="cost">Run the numbers for your app.</Title>
        </div>
        <p className={styles.costLede}>
          Change any assumption. The classic setup pays per relayed gigabyte; with Freehop the relayed share moves to machines
          inside each session, and your gates only pass envelopes.
        </p>
      </div>
      <CostCalculator />
    </Section>
  );
}

export function FinalCta() {
  const motion = useMotionAllowed();
  const hop = arc([-30, 118], [1030, 96], 150);
  return (
    <Section tone="yellow" labelledBy="try" className={styles.final}>
      <svg className={styles.flight} viewBox="0 0 1000 130" aria-hidden="true">
        <HopArc arc={hop} width={6} />
        <Mover arc={hop} dur={7} rest={0.66} motion={motion}>
          <PaperPlane scale={1.6} fold={C.yellow} />
        </Mover>
      </svg>
      <div className={styles.finalInner}>
        <Eyebrow className={styles.finalEyebrow}>No sign-up, no server of ours</Eyebrow>
        <Title id="try" className={styles.finalTitle}>
          Make a real call, right here.
        </Title>
        <p className={styles.finalLede}>
          The live demo runs Freehop in your browser. Two public WebTorrent trackers act as gates and the media goes straight
          between you. Camera and microphone stay off until you press join.
        </p>
        <div className={styles.finalCtas}>
          <Link className={styles.primary} to="/demo">
            <Chevron>Start a live call</Chevron>
          </Link>
          <Link className={styles.secondary} to="/docs/quickstart">
            <Chevron>Read the quickstart</Chevron>
          </Link>
        </div>
      </div>
    </Section>
  );
}
