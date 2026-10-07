import NetworkDiagram from './NetworkDiagram';
export default function UnreachableScene({caption}: {caption?: string}) {
  return (
    <NetworkDiagram
      title="No route, no hidden fallback"
      route="If no route works within the session, Freehop reports unreachable."
      labels={['Strict network', 'No route', 'Strict network']}
      caption={caption}
    />
  );
}
