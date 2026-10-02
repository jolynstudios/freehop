import type {PathKind} from '../PathBadge';
import s from './LiveCall.module.css';

export type ConnectionEvent = {key: string; seconds: number; text: string};
export type ConnectionPeer = {id: string; path: PathKind; via: string | null; connected: boolean; stage?: number; protocol?: string};

export function pathReason(kind: PathKind, stage = 0, via?: string | null) {
  const through = via ? ` (${via.slice(0, 6)})` : '';
  switch (kind) {
    case 'direct': return 'Direct connection established; no machine forwards this pair’s media.';
    case 'gateway': return `Connected through one endpoint’s own gateway${through}.`;
    case 'relay': return `Connected through another machine’s gateway in this session${through}.`;
    case 'bridged': return `A participant${through} forwards this pair’s media because the earlier paths did not connect.`;
    case 'unreachable': return 'No working path yet. Freehop will retry; a network change or another participant may help.';
    default: return stage >= 2 ? 'Trying a forwarding participant after the earlier paths did not connect.'
      : stage >= 1 ? 'Direct or endpoint-gateway attempts did not connect; looking for help inside the session.'
      : 'WebRTC is trying to establish a connection between these devices.';
  }
}

export default function ConnectionStory({active, joined, total, peers, media, events}: {
  active: boolean; joined: number; total: number; peers: ConnectionPeer[]; media: number; events: ConnectionEvent[];
}) {
  const connected = peers.filter(p => p.connected).length;
  return (
    <section className={s.story} aria-labelledby="connection-story-title" id="connection-story">
      <div className={s.storyHeading}>
        <h2 id="connection-story-title">How this call connects</h2>
        <span className={s.storyLabel}>Live connection steps</span>
      </div>
      <ol className={s.steps}>
        <li><h3>1. Find each other</h3><strong>{!active ? 'Ready when you join' : joined ? `${joined} of ${total} trackers connected` : 'Contacting the trackers…'}</strong>
          <p>The demo is configured to use both trackers together. A tracker going offline does not change an established media route.</p></li>
        <li><h3>2. Establish a route</h3><strong>{!active ? 'Waiting for you to join' : !peers.length ? 'Share the invite link' : connected ? `${connected} ${connected === 1 ? 'person has' : 'people have'} a working route` : 'Trying to connect…'}</strong>
          <p>Freehop tries paths between your devices automatically. A route may change when your network changes or a better path becomes available.</p></li>
        <li><h3>3. Carry the call</h3><strong>{!active ? 'Microphone and camera are off' : media > 0 ? 'Media received from the call' : 'No incoming media yet'}</strong>
          <p>The machines in the call carry audio and video. The trackers only carry connection messages.</p></li>
      </ol>
      {active && peers.length > 0 && <ul className={s.routes} aria-label="Current routes">
        {peers.map(peer => <li key={peer.id}><strong>Person {peer.id.slice(0, 6)}</strong><span>{pathReason(peer.path, peer.stage, peer.via)}{peer.protocol ? ` Transport: ${peer.protocol.toUpperCase()}.` : ''}</span></li>)}
      </ul>}
      {events.length > 0 && <details className={s.history}>
        <summary>How we got here · recent connection events</summary>
        <ol>{events.map((event, i) => <li key={`${event.key}-${i}`}><time>+{event.seconds}s</time><span>{event.text}</span></li>)}</ol>
      </details>}
    </section>
  );
}
