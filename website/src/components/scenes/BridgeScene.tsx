import NetworkDiagram from './NetworkDiagram';
export default function BridgeScene({caption}: {caption?: string}) {
  return (
    <NetworkDiagram
      title="Participant forwarding"
      route="A forwarding participant decodes and re-encodes media."
      labels={['Player A', 'Forwarding peer', 'Player B']}
      caption={caption}
    />
  );
}
