// Single in-app rendering of the Terms of Service — used by the /terms page
// (router.tsx) and linked to (never duplicated) from the signup consent
// checkbox on Login.tsx and the Legal section in Settings.
//
// Source of truth: this component mirrors docs/TERMS_OF_SERVICE.md's
// substance. That markdown file stays the canonical, attorney-facing draft
// (it carries the review banner and bracketed legal placeholders — governing
// law, liability caps, legal entity name — that a licensed attorney still
// needs to fill in); this component is the polished, user-facing rendering
// of the same content. If you edit one for a substantive change, update the
// other.
export function TermsOfServiceContent() {
  return (
    <div className="flex flex-col gap-6 text-sm leading-relaxed text-ink">
      <section>
        <h2 className="text-base font-semibold text-ink">1. Acceptance of these terms</h2>
        <p className="mt-2">
          By creating an account or using 554 Properties (the "Service"), you agree to these Terms
          of Service and to our{' '}
          <a href="/privacy" className="text-brand underline">
            Privacy Policy
          </a>
          , which is incorporated by reference. If you don't agree, don't use the Service.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">2. Who can use the Service</h2>
        <p className="mt-2">
          You must be at least 18 years old and able to form a binding contract. The Service is
          intended for landlords, property managers, and similar business users managing rental
          properties — it is not a consumer product for tenants or the general public.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">3. Your account</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            You're responsible for keeping your login credentials confidential and for all
            activity under your account.
          </li>
          <li>You must provide accurate information and keep it up to date.</li>
          <li>Notify us promptly if you suspect unauthorized access to your account.</li>
        </ul>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">4. What the Service does — and doesn't</h2>
        <p className="mt-2">
          554 Properties helps you track properties, tenants, leases, rent collection, and
          expenses, and includes an AI assistant ("Roost") to help you interact with your own data
          conversationally.
        </p>
        <p className="mt-2">
          <strong className="font-medium">554 Properties is not:</strong>
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            A law firm, accountant, or financial advisor. Nothing in the Service — including tax
            set-aside estimates, generated reports, or anything the AI assistant says — constitutes
            legal, tax, or financial advice. Figures like the tax set-aside estimate are estimates
            only and must be independently verified before you rely on them.
          </li>
          <li>
            A tenant-screening or credit-reporting service. The Service does not perform background
            checks, credit checks, or produce "consumer reports," and does not make or influence
            any decision to accept or reject a rental applicant.
          </li>
          <li>
            A substitute for your own compliance obligations. You remain solely responsible for
            complying with landlord-tenant law, fair housing law, tax law, and any other applicable
            law, regardless of what the Service calculates or displays.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">5. The AI assistant</h2>
        <p className="mt-2">
          The assistant answers questions and can propose actions using your own account's data,
          but it never takes a data-changing action automatically — every suggested action requires
          your explicit confirmation, through the same code path (and audit log) as if you'd done
          it manually. Like any AI system, it can make mistakes; you're responsible for reviewing
          and verifying anything it tells you or proposes before acting on it, especially anything
          involving money, tenant communications, or legal/tax matters.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">6. Acceptable use</h2>
        <p className="mt-2">You agree not to use the Service to:</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            Violate any applicable law, including fair housing law, in how you use tenant data or
            make decisions about applicants or tenants.
          </li>
          <li>
            Enter or process personal information about someone without the appropriate basis to
            do so under applicable law.
          </li>
          <li>
            Attempt to access another account's data, probe the Service for vulnerabilities without
            authorization, or interfere with its operation.
          </li>
          <li>
            Send unlawful, harassing, or deceptive communications to tenants or any third party
            through the Service.
          </li>
          <li>Upload malicious content, or content you don't have the right to upload.</li>
        </ul>
        <p className="mt-2">We may suspend or terminate accounts that violate this section.</p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">7. Third-party integrations</h2>
        <p className="mt-2">
          The Service integrates with third-party providers — currently or prospectively Plaid
          and Stripe (bank-account linking via Stripe Financial Connections, and prospectively
          payment processing), Docusign, and email delivery providers. Your use of any integration is also
          subject to that provider's own terms. We choose providers we believe are reputable and
          appropriate for the data involved, but are not responsible for their acts or omissions.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">8. Your data; our license to it</h2>
        <p className="mt-2">
          You own everything you enter into the Service. You grant us a limited license to host,
          process, and display that data solely to provide the Service to you (including sending
          relevant portions to the sub-processors described in our Privacy Policy). We do not claim
          ownership of your data and don't use it for any purpose beyond providing and improving
          the Service to you.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">9. Account closure and data deletion</h2>
        <p className="mt-2">
          You may close your account at any time from Settings. Closing it starts a short,
          cancellable grace period, after which your account and everything in it — properties,
          tenants, transactions, documents, and reports — is permanently and irreversibly deleted.
          This cannot be undone once the grace period elapses. We may suspend or terminate your
          access if you materially violate these Terms, with notice where reasonably practicable.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">10. Disclaimers</h2>
        <p className="mt-2">
          The Service is provided "as is" and "as available," without warranties of any kind,
          express or implied. We don't warrant that the Service will be uninterrupted, error-free,
          or that any figure, report, or AI-generated output is accurate or complete. You are
          responsible for independently verifying any financial, tax, or legal conclusion before
          relying on it.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">11. Limitation of liability</h2>
        <p className="mt-2 text-ink-muted">
          [Pending attorney review — a liability cap and excluded-damages clause appropriate for
          our risk tolerance and jurisdiction will be added here before launch.]
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">12. Indemnification</h2>
        <p className="mt-2">
          You agree to indemnify and hold 554 Properties harmless from claims arising out of your
          violation of these Terms, your violation of any law (including fair housing or
          tenant-privacy law) in your use of the Service, or content/data you submit to it.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">13. Governing law and disputes</h2>
        <p className="mt-2 text-ink-muted">
          [Pending attorney review — governing law and dispute-resolution provisions will be added
          here before launch.]
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">14. Changes to these terms</h2>
        <p className="mt-2">
          We may update these Terms from time to time. We'll update the "Last updated" date on this
          page and, for material changes, provide additional notice before the change takes effect.
          Continued use of the Service after a change takes effect means you accept the updated
          Terms.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">15. Contact</h2>
        <p className="mt-2">
          <a href="mailto:legal@554properties.com" className="text-brand underline">
            legal@554properties.com
          </a>
        </p>
      </section>
    </div>
  );
}
