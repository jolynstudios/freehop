import clsx from 'clsx';
import {useId, type ReactNode} from 'react';
import styles from './scenes.module.css';

export type SceneFrameProps = {
  /** What the picture shows, for screen readers. */
  title: string;
  caption?: string;
  /** viewBox width and height. */
  width?: number;
  height?: number;
  className?: string;
  children: ReactNode;
};

/**
 * A docs illustration: a flat yellow stage with rounded ends, the scene drawn inside, and an
 * optional caption set like signage.
 */
export default function SceneFrame({title, caption, width = 720, height = 300, className, children}: SceneFrameProps) {
  const id = useId();
  return (
    <figure className={clsx(styles.scene, className)}>
      <div className={styles.stage}>
        <svg
          className={styles.svg}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="xMidYMid slice"
          role="img"
          aria-labelledby={`${id}-t`}>
          <title id={`${id}-t`}>{title}</title>
          {children}
        </svg>
      </div>
      {caption && <figcaption className={styles.caption}>{caption}</figcaption>}
    </figure>
  );
}
