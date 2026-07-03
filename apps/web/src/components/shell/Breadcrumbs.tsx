// <nav aria-label="Breadcrumb"> with aria-current="page" on the leaf; on
// mobile it collapses to a back-arrow link to the parent crumb.
import { Link } from 'react-router-dom';
import { IconArrowLeft, IconChevronRight } from '../ui/icons';

export interface Crumb {
  label: string;
  to?: string;
}

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  if (items.length === 0) return null;
  const parent = items.length > 1 ? items[items.length - 2] : undefined;

  return (
    <nav aria-label="Breadcrumb" className="text-sm">
      {/* Mobile: back-arrow variant */}
      {parent?.to && (
        <Link
          to={parent.to}
          className="inline-flex items-center gap-1.5 font-medium text-ink-muted transition-colors duration-fast hover:text-ink md:hidden"
        >
          <IconArrowLeft size={14} />
          Back to {parent.label}
        </Link>
      )}
      {/* Desktop: full trail */}
      <ol className="hidden items-center gap-1.5 md:flex">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`} className="flex items-center gap-1.5">
              {index > 0 && (
                <span aria-hidden="true" className="text-ink-faint">
                  <IconChevronRight size={12} />
                </span>
              )}
              {isLast || !item.to ? (
                <span aria-current={isLast ? 'page' : undefined} className="font-medium text-ink">
                  {item.label}
                </span>
              ) : (
                <Link
                  to={item.to}
                  className="text-ink-muted transition-colors duration-fast hover:text-ink"
                >
                  {item.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
