import type {ReactNode} from 'react';
import styles from './PageHeader.module.css';
export default function PageHeader({eyebrow, title, children}: {eyebrow: string; title: ReactNode; children?: ReactNode; art?: ReactNode}) {
  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <div className={styles.copy}>
          <p className={styles.eyebrow}>{eyebrow}</p>
          <h1 className={styles.title}>{title}</h1>
          {children}
        </div>
      </div>
    </header>
  );
}
