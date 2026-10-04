import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import {C, HopArc, House, Lighthouse, Mailbox, Mover, PaperPlane, arc, useMotionAllowed} from '@site/src/components/illustrations';
import styles from './styles.module.css';

const COLUMNS = [
  {
    title: 'Learn',
    links: [
      {label: 'Introduction', to: '/docs'},
      {label: 'Quickstart', to: '/docs/quickstart'},
      {label: 'Paths and escalation', to: '/docs/concepts/paths'},
      {label: 'Security model', to: '/docs/concepts/security'},
      {label: 'Protocol', to: '/docs/protocol'},
    ],
  },
  {
    title: 'Try',
    links: [
      {label: 'Live call', to: '/demo'},
      {label: 'Interactive demos', to: '/demos'},
      {label: 'Cost model', to: '/docs/concepts/cost'},
      {label: 'SDK reference', to: '/docs/sdk/client'},
    ],
  },
  {
    title: 'Project',
    links: [
      {label: 'Source on GitHub', href: 'https://github.com/jolynstudios/freehop'},
      {label: 'Network test results', to: '/docs/results'},
      {label: 'Use case: Redline Wars', to: '/docs/redline-wars'},
      {label: 'Limits', to: '/docs/limits'},
      {label: 'License and disclaimer', to: '/docs/license'},
    ],
  },
];

const HOMES = [70, 196, 330, 452, 988, 1112, 1244, 1370];

function Skyline() {
  const motion = useMotionAllowed();
  const hop = arc([520, 46], [928, 46], 96);
  return (
    <svg className={styles.skyline} viewBox="0 0 1440 130" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <HopArc arc={hop} />
      {HOMES.map((x, i) => (
        <House key={x} x={x} y={131} scale={i % 3 === 1 ? 0.78 : 0.86} variant={i % 4 === 2 ? 'tall' : 'house'} flip={i % 2 === 1} chimney={i % 3 !== 0} />
      ))}
      <Mailbox x={720} y={131} scale={0.72} flag="up" />
      <Lighthouse x={600} y={131} scale={0.58} beams={false} animate={false} />
      <House x={846} y={131} scale={0.82} door="open" />
      <Mover arc={hop} dur={5} rest={0.5} motion={motion}>
        <PaperPlane fold={C.yellow} />
      </Mover>
    </svg>
  );
}

export default function Footer() {
  const logo = useBaseUrl('/img/logo.svg');
  return (
    <footer className={styles.footer}>
      <Skyline />
      <div className={styles.inner}>
        <div className={styles.brand}>
          <Link to="/" className={styles.wordmark}>
            <img src={logo} alt="" width={40} height={40} />
            <span>Freehop</span>
          </Link>
          <p className={styles.tagline}>
            Peer-to-peer voice, video and data for browsers and desktop apps. Your servers never carry the call.
          </p>
        </div>
        <nav className={styles.columns} aria-label="Footer">
          {COLUMNS.map(column => (
            <div key={column.title} className={styles.column}>
              <h2 className={styles.heading}>{column.title}</h2>
              <ul>
                {column.links.map(link => (
                  <li key={link.label}>
                    {'href' in link ? <Link href={link.href}>{link.label}</Link> : <Link to={link.to}>{link.label}</Link>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>
      <div className={styles.legal}>
        <p className={styles.warranty}>
          Freehop is provided as is, without warranty of any kind. You use it at your own risk.
        </p>
        <p>
          © 2026 Jolyn Studios. Code licensed under Apache-2.0. Documentation and protocol specification licensed
          under CC BY 4.0.
        </p>
      </div>
    </footer>
  );
}
