import NetworkDiagram from './NetworkDiagram';
export default function PathsScene({caption}: {caption?: string}) {
  return (
    <NetworkDiagram
      title="The path ladder"
      route="direct → gateway → relay → bridged → unreachable"
      labels={['Direct peer', 'Session route', 'Remote peer']}
      caption={caption}
    />
  );
}
