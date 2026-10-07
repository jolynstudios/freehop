import NetworkDiagram from './NetworkDiagram';
export default function HostNodeScene({caption}: {caption?: string}) {
  return (
    <NetworkDiagram
      title="Session host"
      route="A host joins the session without media and offers its gateway."
      labels={['Player A', 'Host gateway', 'Player B']}
      caption={caption}
    />
  );
}
