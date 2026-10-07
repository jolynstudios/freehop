import {useEffect, useRef, useState, type ComponentProps} from 'react';
import MDXComponents from '@theme-original/MDXComponents';

function DocumentationTable({tabIndex, children, ...props}: ComponentProps<'table'>) {
  const ref = useRef<HTMLTableElement>(null);
  const [scrollable, setScrollable] = useState(false);

  useEffect(() => {
    const table = ref.current;
    if (!table) return;
    const measure = () => setScrollable(table.scrollWidth > table.clientWidth + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(table);
    // Content width can change independently when fonts load or cells reflow.
    for (const section of Array.from(table.children)) observer.observe(section);
    measure();
    return () => observer.disconnect();
  }, [children]);

  return (
    <table {...props} ref={ref} tabIndex={tabIndex ?? (scrollable ? 0 : undefined)}>
      {children}
    </table>
  );
}

export default {...MDXComponents, table: DocumentationTable};
