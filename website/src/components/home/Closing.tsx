import Link from '@docusaurus/Link';
import {C, HopArc, Mover, PaperPlane, arc, useMotionAllowed} from '../illustrations';
import Section, {Chevron, Eyebrow, Title} from './Section';
import styles from './Closing.module.css';

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
      <Eyebrow className={styles.finalEyebrow}>For the app you are building</Eyebrow>
      <Title id="try" className={styles.finalTitle}>
          Add a real call to your app.
        </Title>
        <p className={styles.finalLede}>
          Keep your own screens, users and room flow. Freehop handles the peer connection, media paths and optional quality adjustment. Start with the developer quickstart, or try the game overlay in your browser.
        </p>
        <div className={styles.finalCtas}>
          <Link className={styles.primary} to="/docs/quickstart">
            <Chevron>Start building</Chevron>
          </Link>
          <Link className={styles.secondary} to="/maze">
            <Chevron>Try the game overlay</Chevron>
          </Link>
        </div>
      </div>
    </Section>
  );
}
