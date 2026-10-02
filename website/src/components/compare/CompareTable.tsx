import clsx from 'clsx';
import Link from '@docusaurus/Link';
import {OPTIONS, type Option} from './data';
import styles from './CompareTable.module.css';

type Column = {key: keyof Option; label: string; className?: string};

const HOME_COLUMNS: Column[] = [
  {key: 'fallback', label: 'When a direct route fails, media goes through'},
  {key: 'bill', label: 'Your media bill'},
  {key: 'size', label: 'Built for'},
];

const FULL_COLUMNS: Column[] = [
  {key: 'signalling', label: 'How people find each other'},
  {key: 'fallback', label: 'When a direct route fails, media goes through'},
  {key: 'bill', label: 'Your media bill'},
  {key: 'size', label: 'Built for'},
  {key: 'e2e', label: 'End-to-end encrypted media'},
  {key: 'license', label: 'License', className: styles.nowrap},
];

function Bill({option}: {option: Option}) {
  return <span className={clsx(styles.bill, styles[`bill_${option.bill}`])}>{option.billText}</span>;
}

function Cell({option, column}: {option: Option; column: Column}) {
  if (column.key === 'bill') return <Bill option={option} />;
  return <>{String(option[column.key])}</>;
}

/** The comparison table: `home` shows the short version, `full` every option and column. */
export default function CompareTable({variant = 'full'}: {variant?: 'home' | 'full'}) {
  const columns = variant === 'home' ? HOME_COLUMNS : FULL_COLUMNS;
  const rows = variant === 'home' ? OPTIONS.filter(o => o.home) : OPTIONS;
  return (
    <div className={clsx(styles.wrap, variant === 'full' && styles.wrapFull)}>
      <div className={styles.scroll} tabIndex={variant === 'full' ? 0 : undefined} role={variant === 'full' ? 'region' : undefined} aria-label={variant === 'full' ? 'Comparison table, scrolls sideways' : undefined}>
        <table className={clsx(styles.table, variant === 'full' && styles.tableFull)}>
          <thead>
            <tr>
              <th scope="col" className={styles.optionHead}>
                Option
              </th>
              {columns.map(c => (
                <th key={c.key} scope="col">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(option => (
              <tr key={option.name} className={clsx(option.ours && styles.ours)}>
                <th scope="row" className={styles.option}>
                  <span className={styles.name}>
                    {option.href.startsWith('/') ? (
                      <Link to={option.href}>{option.name}</Link>
                    ) : (
                      <a href={option.href} target="_blank" rel="noopener noreferrer">
                        {option.name}
                      </a>
                    )}
                    {option.ours && <span className={styles.oursTag}>this project</span>}
                  </span>
                  <span className={styles.kind}>{option.kind}</span>
                </th>
                {columns.map(c => (
                  <td key={c.key} data-label={c.label} className={c.className}>
                    <Cell option={option} column={c} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
