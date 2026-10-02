import Link from '@docusaurus/Link';
import useBrokenLinks from '@docusaurus/useBrokenLinks';
import {C, Envelope, HopArc, House, Mailbox, Mover, PaperPlane, Wall, arc} from '../illustrations';
import Section, {Title} from './Section';
import s from './Explainer.module.css';

function Scene({kind}: {kind: 'meet' | 'call' | 'help'}) {
  const left = arc([68, 120], [160, 63], 35);
  const right = arc([160, 63], [252, 120], 35);
  const direct = arc([68, 105], [252, 105], 70);
  return (
    <svg viewBox="0 0 320 185" aria-hidden="true" className={s.scene}>
      <path d="M24 159 H296" stroke={C.ink} strokeWidth={3} strokeLinecap="round" />
      {kind === 'meet' ? <>
        <HopArc arc={left} pattern="dashes" animate={false} />
        <HopArc arc={right} pattern="dashes" animate={false} />
        <Mailbox x={160} y={106} scale={0.65} />
        <Mover arc={left} motion={false} orient={false}><Envelope scale={0.6} /></Mover>
        <Mover arc={right} motion={false} orient={false}><Envelope scale={0.6} /></Mover>
      </> : kind === 'call' ? <>
        <HopArc arc={direct} animate={false} />
        <Mover arc={direct} motion={false}><PaperPlane scale={0.95} /></Mover>
      </> : <>
        <Wall x={143} y={112} width={34} height={46} course={15} brick={16} />
        <HopArc arc={left} animate={false} />
        <HopArc arc={right} animate={false} />
        <House x={160} y={77} scale={0.42} roof={C.azure} antenna={false} chimney={false} />
        <Mover arc={left} motion={false}><PaperPlane scale={0.65} /></Mover>
        <Mover arc={right} motion={false}><PaperPlane scale={0.65} /></Mover>
      </>}
      <House x={60} y={158} scale={0.67} antenna={false} />
      <House x={260} y={158} scale={0.67} roof={C.azure} antenna={false} flip />
    </svg>
  );
}

/** A short visual example; readable in full without motion or interaction. */
export default function Explainer() {
  useBrokenLinks().collectAnchor('freehop-in-20-seconds');
  return (
    <Section id="freehop-in-20-seconds" labelledBy="explainer-title" className={s.section}>
      <div className={s.heading}>
        <Title id="explainer-title" className={s.title}>Freehop in 20 seconds.</Title>
        <Link to="/demo" className={s.try}>Try it with a friend <span aria-hidden="true">&gt;</span></Link>
      </div>
      <ol className={s.strip}>
        <li><Scene kind="meet" /><h3><span>1</span> Find your friend.</h3>
          <p>Share a link. A gate passes encrypted introductions between your devices.</p></li>
        <li><Scene kind="call" /><h3><span>2</span> Start talking.</h3>
          <p>Your voices and video travel between your devices. The gate carries no audio or video.</p></li>
        <li><Scene kind="help" /><h3><span>3</span> Take another path.</h3>
          <p>Direct path blocked? An available machine in the call can forward it. Some networks still won’t connect.</p></li>
      </ol>
      <p className={s.takeaway}>Freehop adds this to your app. <strong>Your servers don’t carry the call.</strong></p>
    </Section>
  );
}
