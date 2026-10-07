import Link from '@docusaurus/Link';
import s from './UseCases.module.css';

const USE_CASES = [
  {
    id: 'meeting-rooms',
    name: 'Small meeting rooms',
    example: 'Team check-ins, study groups, project calls.',
    description: 'Build a room with a joining link, camera preview and chat. Keep the controls simple and the room part of your own product.',
    capability: 'Voice · video · room messages',
    action: 'Build a meeting room',
  },
  {
    id: 'in-app-calls',
    name: 'Calls inside a small app',
    example: 'A support call beside the customer’s project.',
    description: 'Add a call panel to an existing portal or tool. People can talk while keeping the page, task and context in front of them.',
    capability: 'Your interface · your sign-in',
    action: 'Embed a call',
  },
  {
    id: 'shared-workspaces',
    name: 'Shared workspaces',
    example: 'Design reviews, pair building, shared canvases.',
    description: 'Put a conversation beside the work. Send small events such as a selected item or a raised hand alongside voice and video.',
    capability: 'Media tracks · application events',
    action: 'Connect a workspace',
  },
  {
    id: 'desktop-apps',
    name: 'Desktop collaboration',
    example: 'A team tool with calling built in.',
    description: 'Use the same client in Electron. An optional desktop gateway can help other people in the session connect through difficult networks.',
    capability: 'Browser API · Electron gateway',
    action: 'Build for desktop',
  },
  {
    id: 'community-rooms',
    name: 'Community rooms & games',
    example: 'Club hangouts, co-op voice, small watch groups.',
    description: 'Give a few people a place to talk inside your community or game. Your app supplies the activity; Freehop connects the participants.',
    capability: 'Voice-first rooms · optional video',
    action: 'Add a community room',
  },
];

export default function UseCases() {
  return (
    <section className={s.section} id="use-cases" aria-labelledby="use-cases-title">
      <div className={s.heading}>
        <p className={s.label}>Use cases</p>
        <h2 id="use-cases-title">What you can build.</h2>
        <p className={s.intro}>
          A small room on its own. A call inside an app you already have. These integration ideas use the same SDK, with your interface and your room rules.
        </p>
      </div>
      <div className={s.cases}>
        {USE_CASES.map((item) => (
          <article className={s.item} key={item.id}>
            <div>
              <h3>{item.name}</h3>
              <p className={s.example}>{item.example}</p>
            </div>
            <div className={s.detail}>
              <p>{item.description}</p>
              <span className={s.capability}>{item.capability}</span>
              <Link to={`/docs/use-cases#${item.id}`}>
                {item.action} <span aria-hidden="true">↗</span>
              </Link>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
