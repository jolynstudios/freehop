import type {ReactNode} from 'react';
import clsx from 'clsx';
import styles from './Stats.module.css';

/** A row of evidence numbers. */
export function StatGrid({children, className}: {children: ReactNode; className?: string}) {
  return <div className={clsx(styles.grid, className)}>{children}</div>;
}

/** One number with what it counts and where it comes from. */
export function Stat({value, label, note}: {value: string; label: string; note?: string}) {
  return (
    <div className={styles.stat}>
      <div className={styles.value}>
        <span>{value}</span>
      </div>
      <div className={styles.label}>{label}</div>
      {note && <div className={styles.note}>{note}</div>}
    </div>
  );
}
