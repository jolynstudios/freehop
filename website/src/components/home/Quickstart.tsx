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
    label: 'Browser',
    runtime: 'Runs in the participant’s browser',
    step: 'Browser: join the call',
    note: 'Your frontend gets a ticket from your API, opens the microphone and plays incoming audio.',
    file: 'call.js',
    language: 'js',
    code: `import { connect } from 'freehop';

// This authenticated API endpoint is supplied by your app.
const response = await fetch('/api/rooms/room-42/ticket', { method: 'POST' });
if (!response.ok) throw new Error('Could not join the room');
const ticket = await response.json();
const session = await connect(ticket, { media: { audio: true } });

session.on('track', ({ track }) => {
  if (track.kind !== 'audio') return;
  const audio = document.createElement('audio');
  audio.controls = true;
  document.body.append(audio);
  session.attach(track, audio);
});`,
  },
  {
    id: 'backend',
    label: 'Backend',
    runtime: 'Runs on your application backend · Node.js',
    step: 'Backend: admit participants',
    note: 'It decides who is in a room. A kick rotates the room secret.',
    file: 'server.mjs',
    language: 'js',
    code: `import { createAuthority } from 'freehop/authority';

const authority = createAuthority({
  app: 'my-app',
  gates: ['wss://gate.example.com/freehop'],
  gateTokenSecrets: {
    'wss://gate.example.com/freehop': process.env.FREEHOP_GATE_TOKEN_SECRET,
  },
  stun: ['stun:gate.example.com:3478'],
});

await authority.openRoom('room-42');
const ticket = await authority.ticket('room-42', 'user-7');   // send it over your own channel
const { tickets } = await authority.kick('room-42', 'user-3'); // new secret for everyone else`,
  },
  {
    id: 'gate',
    label: 'Gate',
    runtime: 'Runs on a gate server · terminal',
    step: 'Gate: introduce the browsers',
    note: 'Use your own signalling service or a public tracker. A tracker needs no gate server of yours.',
    file: 'terminal',
    language: 'bash',
    code: `FREEHOP_GATE_PORT=8787 \\
FREEHOP_GATE_PUBLIC_HOST=gate.example.com \\
FREEHOP_GATE_STUN='0.0.0.0:3478,[::]:3478' \\
FREEHOP_GATE_TOKEN_SECRET="$FREEHOP_GATE_TOKEN_SECRET" \\
FREEHOP_GATE_TOKEN_AUDIENCE=wss://gate.example.com/freehop \\
FREEHOP_GATE_TRUST_PROXY=1 \\
node bin/freehop-gate.mjs`,
  },
  {
    id: 'desktop',
    label: 'Desktop',
    runtime: 'Runs in the Electron main process · Node.js',
    step: 'Desktop: offer a gateway',
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
    label: 'Session host',
    runtime: 'Runs on a session-owned desktop or community server · Node.js',
    step: 'Session host: relay when needed',
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
  const install = 'npm install freehop@alpha';

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
        Where each piece runs.
      </Title>
      <div className={styles.grid}>
        <div className={styles.copy}>
          <p className={styles.intro}>The browser handles the call. Your backend decides who can join. A gate introduces participants; desktop and session-host gateways are optional.</p>
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
                {t.label}
              </button>
            ))}
          </div>
          <div className={styles.code} key={tab.id} role="tabpanel" aria-label={`${tab.label} example`}>
            <p className={styles.runtime}><strong>{tab.runtime}</strong><code>{tab.file}</code></p>
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
          <p className={styles.installNote}>Install Freehop alpha 0.1.0-alpha.0 from npm, then bundle the browser import with your frontend build. Node 22+ is for backend, gate and gateway processes.</p>
          <Link className={styles.more} to="/docs/quickstart">
            <Chevron>Walk through the full quickstart</Chevron>
          </Link>
        </div>
      </div>
    </Section>
  );
}
