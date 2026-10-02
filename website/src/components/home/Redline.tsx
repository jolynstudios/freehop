import Link from '@docusaurus/Link';
import {C, Cloud, Envelope, HopArc, House, Lighthouse, Mailbox, Mover, NameTag, PaperPlane, arc, motion as m, useMotionAllowed} from '../illustrations';
import {onEllipse} from '../scenes/ground';
import Section, {Chevron, Eyebrow, Title} from './Section';
import styles from './Redline.module.css';

const ISLAND = {cx: 280, cy: 328, rx: 272, ry: 64};

function Match() {
  const motion = useMotionAllowed();
  const homes = [86, 172, 388, 474].map((x, i) => ({...onEllipse(ISLAND.cx, ISLAND.cy, ISLAND.rx, ISLAND.ry, x), team: i < 2 ? C.coral : C.azure}));
  const across = arc([150, 184], [410, 184], 230);
  const relayIn = arc([122, 214], [262, 136], 44);
  const relayOut = arc([298, 136], [438, 214], 44);
  const mail = arc([190, 196], [104, 70], -40);
  return (
    <svg className={styles.svg} viewBox="0 0 560 400" role="img" aria-label="A match: two teams' homes with red and blue pennants stand on a blue island around a lighthouse, the match's host node. Paper planes fly between the teams and through the lighthouse; a mailbox gate on a cloud receives a sealed envelope.">
      <Cloud x={96} y={110} scale={0.9} className={m.drift} />
      <Mailbox x={96} y={86} scale={0.52} flag="anim" />
      <Cloud x={470} y={72} scale={0.62} flip className={m.driftLate} />
      <ellipse cx={ISLAND.cx} cy={ISLAND.cy} rx={ISLAND.rx} ry={ISLAND.ry} fill={C.azure} stroke={C.ink} strokeWidth={6} />
      <HopArc arc={across} />
      <HopArc arc={relayIn} />
      <HopArc arc={relayOut} />
      <HopArc arc={mail} pattern="dashes" slow />
      {homes.map(({x, y, angle, team}, i) => (
        <House key={x} x={x} y={y + 2} rotate={angle} scale={0.86} flip={i >= 2} flag={team} antenna={false} door={i === 1 ? 'swing' : 'closed'} />
      ))}
      <Lighthouse x={280} y={266} scale={0.98} beams={false} />
      <NameTag x={280} y={298} text="HOST NODE" size={16} />
      <Mover arc={across} dur={4} rest={0.5} motion={motion}>
        <PaperPlane />
      </Mover>
      <Mover arc={relayIn} dur={3.4} travel={0.5} rest={0.5} motion={motion}>
        <PaperPlane scale={0.85} fold={C.yellow} />
      </Mover>
      <Mover arc={relayOut} dur={3.4} begin={1.7} travel={0.5} rest={0.5} motion={motion}>
        <PaperPlane scale={0.85} fold={C.yellow} />
      </Mover>
      <Mover arc={mail} dur={6} travel={0.3} rest={0.55} orient={false} motion={motion}>
        <Envelope scale={0.55} />
      </Mover>
      <NameTag x={150} y={338} text="TEAM RED" size={15} />
      <NameTag x={410} y={338} text="TEAM BLUE" size={15} />
    </svg>
  );
}

export default function Redline() {
  return (
    <Section tone="yellow" labelledBy="redline">
      <div className={styles.grid}>
        <div className={styles.art}>
          <Match />
        </div>
        <div className={styles.copy}>
          <Eyebrow>Example consumer</Eyebrow>
          <Title id="redline">One app. The same SDK.</Title>
          <p className={styles.lede}>
            Redline Wars is a real-time strategy game for the browser and the desktop. It plans to use
            Freehop through the public SDK, just like any other app. Freehop is an independent project.
          </p>
          <p className={styles.body}>
            Every match already has a host node: the machine that runs it. That is exactly where Freehop's relay rung lives, so
            two participants behind hard NATs can still talk without the game's own servers carrying their voices.
          </p>
          <p className={styles.status}>
            <span className={styles.dot} aria-hidden="true" />
            Integration in progress. Voice is not live in the game yet.
          </p>
          <div className={styles.links}>
            <Link className={styles.primary} href="https://redlinewars.online">
              <Chevron>Play Redline Wars</Chevron>
            </Link>
            <Link className={styles.secondary} to="/docs/redline-wars">
              <Chevron>Read the use case</Chevron>
            </Link>
            <Link className={styles.tertiary} href="https://github.com/jolynstudios/redlinewars">
              Game source
            </Link>
          </div>
        </div>
      </div>
    </Section>
  );
}
