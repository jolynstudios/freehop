import NetworkDiagram from './NetworkDiagram';
export default function GateScene({caption}: {caption?: string}) {
  return (
    <NetworkDiagram
      title="Sealed signalling"
      route="The gate passes encrypted setup messages. It never carries media."
      labels={['Player A', 'Gate', 'Player B']}
      caption={caption}
    />
  );
}
