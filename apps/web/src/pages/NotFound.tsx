import { Link } from 'react-router-dom';
import { buttonClasses } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { IconHome } from '../components/ui/icons';
import { usePageTitle } from '../lib/usePageTitle';

export function NotFound() {
  usePageTitle('Page not found');
  return (
    <div className="mx-auto max-w-lg pt-12">
      <h1 className="sr-only">Page not found</h1>
      <Card flush>
        <EmptyState
          icon={<IconHome size={28} />}
          title="Page not found"
          body="The page you're looking for doesn't exist or may have moved."
          action={
            <Link to="/" className={buttonClasses('primary')}>
              Back to dashboard
            </Link>
          }
        />
      </Card>
    </div>
  );
}
