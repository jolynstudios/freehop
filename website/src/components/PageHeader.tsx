import type {ReactNode} from 'react';
import styles from './PageHeader.module.css';

/** A short yellow scene at the top of a standalone page: title on the left, a drawing on the right. */
export default function PageHeader({eyebrow, title, children, art}: {eyebrow: string; title: ReactNode; children?: ReactNode; art?: ReactNode}) {
  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <div className={styles.copy}>
          <p className={styles.eyebrow}>{eyebrow}</p>
          <h1 className={styles.title}>{title}</h1>
          {children}
        </div>
        {art && <div className={styles.art}>{art}</div>}
      </div>
    </header>
  );
}
