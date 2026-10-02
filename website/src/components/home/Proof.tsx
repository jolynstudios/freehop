import Link from '@docusaurus/Link';
import PathBadge, {type PathKind} from '../PathBadge';
import Section, {Chevron, Eyebrow, Title} from './Section';
import styles from './Proof.module.css';

const STATS = [
  {value: '40/40', label: 'lab runs passed', note: '11 network scenarios × 3 trials, plus 7 cross-engine runs'},
  {value: '79/79', label: 'unit tests', note: 'STUN codec, TURN server, port mapper, gate and gateway'},
  {value: '800/800', label: 'TURN messages, UDP and TCP', note: "coturn's turnutils_uclient against Freehop's TURN: 0 lost"},
  {value: '3', label: 'browser engines', note: 'Chromium 151, Firefox 153 and WebKit 26.5'},
];

type Row = {setup: string; detail: string; kind: PathKind; via?: string; runs: string; gate: string};
const ROWS: Row[] = [
  {setup: 'Two home routers', detail: 'direct-eim', kind: 'direct', runs: '3/3 + 1/1', gate: '31–34 KB'},
  {setup: 'IPv6, IPv4 UDP blocked', detail: 'ipv6-direct', kind: 'direct', runs: '3/3 + 1/1', gate: '30–34 KB'},
  {setup: 'Strict NAT and a desktop player (UPnP)', detail: 'two-player-desktop-host', kind: 'gateway', runs: '3/3 + 1/1', gate: '34–66 KB'},
  {setup: 'UDP-blocked and a desktop player', detail: 'udpblock-gateway, TURN over TCP', kind: 'gateway', runs: '3/3 + 1/1', gate: '31–63 KB'},
  {setup: 'Two strict NATs and a desktop player', detail: 'hard-pair-gateway', kind: 'relay', via: 'desktop player', runs: '3/3 + 1/1', gate: '143–201 KB'},
  {setup: 'Two UDP-blocked and a desktop player', detail: 'udpblock-pair-gateway', kind: 'relay', via: 'desktop player', runs: '3/3', gate: '130–158 KB'},
  {setup: 'Two strict NATs and a host node', detail: 'hard-pair-host-node', kind: 'relay', via: 'host node', runs: '3/3 + 1/1', gate: '62–73 KB'},
  {setup: 'Two UDP-blocked and a host node', detail: 'udpblock-pair-host-node', kind: 'relay', via: 'host node', runs: '3/3', gate: '65 KB'},
  {setup: 'Two strict NATs and an open participant', detail: 'hard-pair-bridge', kind: 'bridged', via: 'participant', runs: '3/3 + 1/1', gate: '91–115 KB'},
  {setup: 'Two strict NATs, nobody else', detail: 'hard-pair, expected', kind: 'unreachable', runs: '3/3', gate: '93 KB'},
  {setup: 'A network that reaches only the gate', detail: 'gate-only, expected', kind: 'unreachable', runs: '3/3', gate: '207 KB'},
];

const NOT_YET = [
  'Physical home routers and routers without UPnP, PCP or NAT-PMP',
  '4G and 5G carrier NAT',
  'Corporate networks that block UDP',
  'iOS Safari and Android browsers',
  'Media quality under real load, and the upload a forwarding player can spare',
];

export default function Proof() {
  return (
    <Section tone="surface" labelledBy="proof">
      <div className={styles.head}>
        <div>
          <Eyebrow>Evidence</Eyebrow>
          <Title id="proof">Lab-qualified. Not yet street-tested.</Title>
        </div>
        <p className={styles.lede}>
          Real browsers ran behind real kernel NATs in an isolated Linux lab. Every run checked the path both sides reported, that
          audio packets and decoded video frames actually arrived, and that the gate only carried signalling.
        </p>
      </div>

      <ul className={styles.stats}>
        {STATS.map(stat => (
          <li key={stat.label} className={styles.stat}>
            <span className={styles.value}>{stat.value}</span>
            <span className={styles.label}>{stat.label}</span>
            <span className={styles.note}>{stat.note}</span>
          </li>
        ))}
      </ul>

      <div className={styles.tableWrap}>
        <table className={styles.table} aria-describedby="proof-table-note">
          <thead>
            <tr>
              <th scope="col">Network setup</th>
              <th scope="col">Path</th>
              <th scope="col">Passed</th>
              <th scope="col">Gate traffic per run</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map(row => (
              <tr key={row.detail}>
                <th scope="row">
                  <span className={styles.setup}>{row.setup}</span>
                  <span className={styles.detail}>{row.detail}</span>
                </th>
                <td data-label="Path">
                  <PathBadge kind={row.kind} via={row.via} />
                </td>
                <td data-label="Passed" className={styles.mono}>
                  {row.runs}
                </td>
                <td data-label="Gate traffic" className={styles.mono}>
                  {row.gate}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p id="proof-table-note" className={styles.caption}>
          Final qualification, 2 October 2026. "+ 1/1" is the extra run with Firefox and WebKit behind the hard networks.
        </p>
      </div>

      <div className={styles.notYet}>
        <div>
          <h3 className={styles.notYetTitle}>Not verified yet</h3>
          <p className={styles.notYetText}>Freehop is alpha. These are the next phases, in the open:</p>
        </div>
        <ul>
          {NOT_YET.map(item => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <Link className={styles.more} to="/docs/results">
          <Chevron>Full results and how to reproduce them</Chevron>
        </Link>
      </div>
    </Section>
  );
}
