import {useState} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import CodeBlock from '@theme/CodeBlock';
import PathBadge, {type PathKind} from '../PathBadge';
import Section, {Chevron, Eyebrow, Title} from './Section';
import styles from './Quickstart.module.css';

const TABS = [
  {
    id: 'client',
    step: 'Clients join with a ticket',
    note: 'connect() does the rest: gates, sealed signalling, the path ladder.',
    file: 'call.js',
    language: 'js',
    code: `import { connect } from 'freehop';

const session = await connect(ticket, { media: { audio: true } });
session.on('track', ({ peer, track }) => session.attach(track, el(peer)));
session.on('path', ({ peer, kind }) => show(peer, kind));
session.on('peer-left', ({ id }) => remove(id));`,
  },
  {
    id: 'backend',
    step: 'Your backend issues tickets',
    note: 'It decides who is in a room. A kick rotates the room secret.',
    file: 'server.mjs',
    language: 'js',
    code: `import { createAuthority } from 'freehop/authority';

const authority = createAuthority({
  app: 'my-app',
  gates: ['wss://gate.example.com/freehop'],
  gateTokenSecret: process.env.FREEHOP_GATE_TOKEN_SECRET,
});

await authority.openRoom('room-42');
const ticket = await authority.ticket('room-42', 'user-7');   // send it over your own channel
const { tickets } = await authority.kick('room-42', 'user-3'); // new secret for everyone else`,
  },
  {
    id: 'gate',
    step: 'Run a gate, or several',
    note: 'Signalling only. Public WebTorrent trackers work as gates too.',
    file: 'terminal',
    language: 'bash',
    code: `FREEHOP_GATE_PORT=8787 \\
FREEHOP_GATE_PUBLIC_HOST=gate.example.com \\
FREEHOP_GATE_STUN=0.0.0.0:3478,[::]:3478 \\
FREEHOP_GATE_TOKEN_SECRET=change-me \\
FREEHOP_GATE_TRUST_PROXY=1 \\
node bin/freehop-gate.mjs`,
  },
  {
    id: 'desktop',
    step: 'Desktop apps open their front door',
    note: 'Optional. TURN on the participant’s machine plus a router port mapping.',
    file: 'electron-main.mjs',
    language: 'js',
    code: `import { installFreehopGateway } from 'freehop/electron';

const freehop = installFreehopGateway({ ipcMain, allowedOrigins: ['https://play.example.com'] }); // starts on first use
app.on('will-quit', () => freehop.close());
// BrowserWindow: preload 'freehop/electron/preload',
// additionalArguments: ['--freehop-origins=https://play.example.com']`,
  },
  {
    id: 'host',
    step: 'Hosts lend their gateway',
    note: 'Optional. The machine that hosts the session joins without media.',
    file: 'host.mjs',
    language: 'js',
    code: `import { hostSession } from 'freehop/host';

const host = await hostSession(hostTicket);            // host.available is false when unreachable
await host.update(nextTicket, { dropped: [peerId] });  // after a kick
await host.close();`,
  },
];

const KINDS: {kind: PathKind; text: string}[] = [
  {kind: 'direct', text: 'nothing in between'},
  {kind: 'gateway', text: "one participant's own front door"},
  {kind: 'relay', text: "another member's gateway"},
  {kind: 'bridged', text: 'forwarded by a participant'},
  {kind: 'unreachable', text: 'no route inside the session'},
];

export default function Quickstart() {
  const [active, setActive] = useState(TABS[0].id);
  const [copied, setCopied] = useState(false);
  const tab = TABS.find(t => t.id === active) ?? TABS[0];
  const install = 'npm install github:jolynstudios/freehop';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(install);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Section tone="surface" labelledBy="quickstart">
      <Eyebrow>Quickstart</Eyebrow>
      <Title id="quickstart" className={styles.title}>
        Five lines in the browser.
      </Title>
      <div className={styles.grid}>
        <div className={styles.copy}>
          <p className={styles.intro}>Five pieces make an integration. Only the first three are required.</p>
          <ol className={styles.steps}>
            {TABS.map((t, i) => (
              <li key={t.id}>
                <button type="button" className={clsx(styles.step, active === t.id && styles.stepOn)} onClick={() => setActive(t.id)} aria-pressed={active === t.id}>
                  <span className={styles.stepNum}>{i + 1}</span>
                  <span className={styles.stepText}>
                    <span className={styles.stepTitle}>{t.step}</span>
                    <span className={styles.stepNote}>{t.note}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>
        <div className={styles.codeCol}>
          <div className={styles.tabs} role="tablist" aria-label="Quickstart code">
            {TABS.map(t => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active === t.id}
                className={clsx(styles.tab, active === t.id && styles.tabOn)}
                onClick={() => setActive(t.id)}>
                {t.file}
              </button>
            ))}
          </div>
          <div className={styles.code} key={tab.id}>
            <CodeBlock language={tab.language}>{tab.code}</CodeBlock>
          </div>
          <div className={styles.legend}>
            <p className={styles.legendTitle}>
              Your app hears which road each pair took, through <code>session.on('path')</code>:
            </p>
            <ul className={styles.kinds}>
              {KINDS.map(k => (
                <li key={k.kind}>
                  <PathBadge kind={k.kind} />
                  <span>{k.text}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className={styles.install}>
            <span className={styles.chev} aria-hidden="true">
              &gt;
            </span>
            <code className={styles.installCode}>{install}</code>
            <button type="button" className={styles.copyBtn} onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className={styles.installNote}>Alpha, not on the npm registry yet. Node 22 or newer; the browser client has no dependencies.</p>
          <Link className={styles.more} to="/docs/quickstart">
            <Chevron>Walk through the full quickstart</Chevron>
          </Link>
        </div>
      </div>
    </Section>
  );
}
