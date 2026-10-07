import NetworkDiagram from './NetworkDiagram';
export default function GatewayScene({caption}: {caption?: string}) {
  return (
    <NetworkDiagram
      title="Desktop gateway"
      route="The participant offers a bounded TURN gateway through its router."
      labels={['Browser', 'Desktop gateway', 'Desktop player']}
      caption={caption}
    />
  );
}
