import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
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
      {label: 'Signal Run · Three.js', to: '/maze'},
      {label: 'Orbital · Three.js', to: '/orbital'},
      {label: 'Hopper squad rooms', to: '/hopper'},
      {label: 'Comms lab', to: '/demo'},
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

export default function Footer() {
  const logo = useBaseUrl('/img/logo.svg');
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <div className={styles.brand}>
          <Link to="/" className={styles.wordmark}>
            <img src={logo} alt="" width={40} height={40} />
            <span>freehop</span>
          </Link>
          <p className={styles.tagline}>Open-source comms for the worlds you build. Browser games, Electron apps, and your next platform.</p>
        </div>
        <nav className={styles.columns} aria-label="Footer">
          {COLUMNS.map((column) => (
            <div key={column.title} className={styles.column}>
              <h2 className={styles.heading}>{column.title}</h2>
              <ul>
                {column.links.map((link) => (
                  <li key={link.label}>{'href' in link ? <Link href={link.href}>{link.label}</Link> : <Link to={link.to}>{link.label}</Link>}</li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>
      <div className={styles.legal}>
        <p className={styles.warranty}>Freehop is provided as is, without warranty of any kind. You use it at your own risk.</p>
        <p>© 2026 Jolyn Studios. Code licensed under Apache-2.0. Documentation and protocol specification licensed under CC BY 4.0.</p>
      </div>
    </footer>
  );
}
