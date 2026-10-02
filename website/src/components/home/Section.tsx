import clsx from 'clsx';
import type {ReactNode} from 'react';
import styles from './Section.module.css';

type Tone = 'paper' | 'yellow' | 'surface';

/** A full-bleed home page band with a centred 1200px container. */
export default function Section({
  tone = 'paper',
  id,
  className,
  innerClassName,
  labelledBy,
  children,
}: {
  tone?: Tone;
  id?: string;
  className?: string;
  innerClassName?: string;
  labelledBy?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={labelledBy} className={clsx(styles.section, styles[tone], className)}>
      <div className={clsx(styles.inner, innerClassName)}>{children}</div>
    </section>
  );
}

/** Small label above a section title. */
export function Eyebrow({children, className}: {children: ReactNode; className?: string}) {
  return <p className={clsx(styles.eyebrow, className)}>{children}</p>;
}

/** Display title: Changa One, tight and stacked. */
export function Title({id, children, className}: {id?: string; children: ReactNode; className?: string}) {
  return (
    <h2 id={id} className={clsx(styles.title, className)}>
      {children}
    </h2>
  );
}

/** A text link with the trailing chevron. */
export function Chevron({children}: {children: ReactNode}) {
  return (
    <span className={styles.chevronText}>
      {children}
      <span aria-hidden="true" className={styles.chevron}>
        &gt;
      </span>
    </span>
  );
}
