import NetworkDiagram from './NetworkDiagram';
export default function RedlineScene({caption}: {caption?: string}) {
  return (
    <NetworkDiagram
      title="Games host the session"
      route="A planned integration: the match host also offers a session gateway."
      labels={['Browser player', 'Match host', 'Desktop player']}
      caption={caption}
    />
  );
}
