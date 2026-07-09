// Public route (router.tsx: /privacy), reachable without being signed in —
// linked from the signup consent checkbox (Login.tsx), Settings' Legal
// section, and meant to also be the stable URL used for the Google OAuth
// consent screen, app-store listings, and email footers.
import { PrivacyPolicyContent } from '../components/legal/PrivacyPolicyContent';
import { LegalPageLayout } from '../components/legal/LegalPageLayout';
import { usePageTitle } from '../lib/usePageTitle';

export function PrivacyPolicy() {
  usePageTitle('Privacy Policy');
  return (
    <LegalPageLayout title="Privacy Policy" lastUpdated="July 9, 2026">
      <PrivacyPolicyContent />
    </LegalPageLayout>
  );
}
