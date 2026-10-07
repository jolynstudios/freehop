import NetworkDiagram from './NetworkDiagram';
export default function CostScene({caption}: {caption?: string}) {
  return (
    <NetworkDiagram
      title="Separate the traffic"
      route="Signalling goes through gates. Media costs belong to session routes."
      labels={['Signalling', 'Gate: no media', 'Session media']}
      caption={caption}
    />
  );
}
