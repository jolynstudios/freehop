import NetworkDiagram from './NetworkDiagram';
export default function IntroScene({caption}: {caption?: string}) {
  return (
    <NetworkDiagram
      title="A session, connected"
      route="Gates introduce peers. Media stays inside the session."
      labels={['Player A', 'Session peers', 'Player B']}
      caption={caption}
    />
  );
}
