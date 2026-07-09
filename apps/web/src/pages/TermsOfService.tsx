// Public route (router.tsx: /terms), reachable without being signed in —
// linked from the signup consent checkbox (Login.tsx), Settings' Legal
// section, and meant to also be the stable URL used for the Google OAuth
// consent screen, app-store listings, and email footers.
import { TermsOfServiceContent } from '../components/legal/TermsOfServiceContent';
import { LegalPageLayout } from '../components/legal/LegalPageLayout';
import { usePageTitle } from '../lib/usePageTitle';

export function TermsOfService() {
  usePageTitle('Terms of Service');
  return (
    <LegalPageLayout title="Terms of Service" lastUpdated="July 9, 2026">
      <TermsOfServiceContent />
    </LegalPageLayout>
  );
}
