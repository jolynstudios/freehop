import s from './network.module.css';
export default function NetworkDiagram({title, route, labels, caption}: {title: string; route: string; labels: string[]; caption?: string}) {
  return (
    <figure className={s.figure}>
      <div className={s.top}>
        <span>FREEHOP / NETWORK MODEL</span>
        <strong>{title}</strong>
      </div>
      <div className={s.nodes}>
        {labels.map((label, i) => (
          <div key={label} className={s.step}>
            <div className={s.node}>
              <span>{i === 1 ? '◇' : '◈'}</span>
              {label}
            </div>
            {i < labels.length - 1 && (
              <span className={s.arrow} aria-hidden="true">
                →
              </span>
            )}
          </div>
        ))}
      </div>
      <p className={s.route}>{route}</p>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
