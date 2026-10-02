import clsx from 'clsx';
import styles from './PathBadge.module.css';

export type PathKind = 'direct' | 'gateway' | 'relay' | 'bridged' | 'unreachable' | 'connecting';

const LABEL: Record<PathKind, string> = {
  direct: 'direct',
  gateway: 'gateway',
  relay: 'relay',
  bridged: 'bridged',
  unreachable: 'unreachable',
  connecting: 'connecting',
};

/** The route a pair of peers uses, as Freehop's `path` event names it. */
export default function PathBadge({kind, via, size = 'md', className}: {kind: PathKind; via?: string; size?: 'sm' | 'md' | 'lg'; className?: string}) {
  return (
    <span className={clsx(styles.badge, styles[kind], styles[size], className)}>
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.kind}>{LABEL[kind]}</span>
      {via && <span className={styles.via}>via {via}</span>}
    </span>
  );
}
