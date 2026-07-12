// Single in-app rendering of the Privacy Policy — used by the /privacy page
// (router.tsx) and linked to (never duplicated) from the signup consent
// checkbox on Login.tsx and the Legal section in Settings.
//
// Source of truth: this component mirrors docs/PRIVACY_POLICY.md's
// substance. That markdown file stays the canonical, attorney-facing draft
// (it carries the review banner and bracketed legal placeholders that would
// look broken shown to a real visitor); this component is the polished,
// user-facing rendering of the same content. If you edit one for a
// substantive change, update the other.
export function PrivacyPolicyContent() {
  return (
    <div className="flex flex-col gap-6 text-sm leading-relaxed text-ink">
      <section>
        <h2 className="text-base font-semibold text-ink">1. Who this policy covers</h2>
        <p className="mt-2">
          554 Properties ("554 Properties," "we," "us," "our") provides software that helps
          independent landlords manage rental properties, tenants, leases, rent collection,
          bookkeeping, and reporting, including an AI assistant ("Roost") and, where enabled, bank
          transaction import via Plaid or Stripe Financial Connections. This policy describes how
          we handle personal information when you use the 554 Properties web application. It
          applies to:
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            <strong className="font-medium">You, the account owner</strong> — the landlord or
            property manager who signs up for and uses the Service.
          </li>
          <li>
            <strong className="font-medium">Data about tenants, applicants, and other people</strong>{' '}
            that you enter into the Service. For that data, you are the data controller and we act
            as your service provider — processing it on your behalf, under your instructions. See{' '}
            <a href="#tenants" className="text-brand underline">
              §9
            </a>{' '}
            if you're a tenant, not a 554 Properties account holder.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">2. What we collect</h2>
        <h3 className="mt-3 font-medium text-ink">Information you provide directly</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            Account/profile data: name, email, password (handled by our authentication provider,
            Supabase — we never see or store your raw password), timezone, and account settings.
          </li>
          <li>
            Tenant and lease data you enter: tenant name, email, phone, notes, lease terms, and
            co-tenant relationships.
          </li>
          <li>Property data: addresses, unit details, acquisition date/cost, notes.</li>
          <li>
            Financial/transaction data: every income and expense entry you record or confirm —
            amount, date, category, vendor, and description.
          </li>
          <li>
            Documents you upload: leases, receipts, insurance documents, inspection reports,
            notices, tax documents, or anything else attached to a property, unit, tenant, lease,
            or transaction.
          </li>
          <li>Chat messages you send to the AI assistant, and any files you submit to it.</li>
        </ul>
        <h3 className="mt-4 font-medium text-ink">From linked third-party accounts</h3>
        <p className="mt-2">
          Bank transaction data, only if you connect a bank account: date, amount, description,
          and an aggregator-assigned transaction id for transactions you import. You choose the
          aggregator when connecting — Plaid or Stripe Financial Connections. We never receive or
          store your online banking username or password — the aggregator handles that exchange
          directly with your bank. With Plaid, we receive a secure access token, which we encrypt
          before storing; with Stripe Financial Connections, we store only opaque account
          identifiers that are unusable outside our own Stripe account — no bank credential or
          bearer token of any kind.
        </p>
        <h3 className="mt-4 font-medium text-ink">Collected automatically</h3>
        <p className="mt-2">
          IP address, browser/device information, timestamps, and pages/actions used. We also keep
          an internal audit log of every write action that touches money or tenant data (who/what/
          when) for your own recordkeeping and security investigation — not shared externally.
        </p>
        <p className="mt-2">
          <strong className="font-medium">
            Push notification device token, only if you use the iOS app and allow notifications:
          </strong>{' '}
          an Apple-issued device token that lets us send push notifications (e.g., &ldquo;rent
          received&rdquo;, late-rent alerts) to your device through the Apple Push Notification
          service. It identifies your device for notification delivery only — it contains no
          personal information and cannot be used to read anything on your device. It is stored
          against your account, refreshed when you open the app, deleted when you sign out or when
          Apple reports the device is no longer registered, and shared with no one other than
          Apple (as required to deliver the notification). Notification content is generated from
          your own account data.
        </p>
        <p className="mt-2">
          <strong className="font-medium">Face ID / biometrics — not collected:</strong> if you
          enable the optional Face ID lock in the iOS app, authentication happens entirely on your
          device through Apple&rsquo;s APIs. We never receive, store, or have access to any
          biometric data; the app only learns that the unlock succeeded.
        </p>
        <h3 className="mt-4 font-medium text-ink">What we don't currently collect</h3>
        <p className="mt-2">
          554 Properties does not perform tenant credit checks, background checks, or any
          consumer-report-based screening, and does not use AI to make or influence any accept/deny
          decision about a rental applicant or tenant.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">3. How we use information</h2>
        <p className="mt-2">
          Only to operate, maintain, and improve the Service: authenticating and securing your
          account; storing and displaying your properties, tenants, leases, transactions, and
          documents; calculating the figures the Service shows you; powering the AI assistant with
          your own account data as context; importing bank transactions you've asked us to import;
          sending service-related communications; maintaining security and enforcing our Terms;
          and complying with legal obligations.
        </p>
        <p className="mt-2">
          <strong className="font-medium">
            We do not sell your personal information or your tenants' personal information
          </strong>
          , and we do not share it with third parties for their own advertising purposes.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">4. The AI assistant and Anthropic</h2>
        <p className="mt-2">
          The in-app assistant ("Roost") is built on Claude, provided by Anthropic. When you ask it
          a question, it may look up your own portfolio data — which can include tenant names,
          contact info, exact dollar amounts, vendor names, and lease terms — and that data, along
          with your message, is sent to Anthropic's API to generate a response, scoped only to your
          own account's data. If you use AI-powered receipt scanning, the receipt image itself is
          sent to Anthropic's API to extract vendor, amount, and date.
        </p>
        <p className="mt-2">
          Under the commercial API terms we operate under, Anthropic does not use your data to
          train its models. Action suggestions from the assistant are never executed automatically
          — you must explicitly confirm any data-changing action, which then runs through the same
          code path and audit trail as if you'd done it directly in the app.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">5. How we protect your information</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>All traffic to the Service is encrypted in transit (HTTPS/TLS).</li>
          <li>Passwords are managed entirely by our authentication provider — we never see them.</li>
          <li>
            Bank-account access tokens (from Plaid) are encrypted at rest before storage, using a
            dedicated key never checked into source control. Stripe Financial Connections links
            involve no stored bank credential at all — only opaque Stripe account identifiers.
          </li>
          <li>
            Every account's data is logically separated from every other account's — a request
            under one account can never read or write another account's data.
          </li>
          <li>
            Uploaded files are validated against their actual content, not just a client-supplied
            label, before being accepted.
          </li>
        </ul>
        <p className="mt-2">
          No system is 100% secure. If we experience a data breach affecting your personal
          information, we will notify you and any required regulators as applicable law requires.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">6. Who we share information with</h2>
        <p className="mt-2">
          We use a small number of service providers to operate 554 Properties, each contractually
          limited to using your data only to provide their specific function to us:
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            <strong className="font-medium">Supabase</strong> — database hosting, authentication,
            and file storage.
          </li>
          <li>
            <strong className="font-medium">Plaid</strong> — bank-account linking and transaction
            data, only if you connect a bank account through Plaid.
          </li>
          <li>
            <strong className="font-medium">Stripe</strong> — bank-account linking and transaction
            data via Stripe Financial Connections, only if you connect a bank account through
            Stripe.
          </li>
          <li>
            <strong className="font-medium">Anthropic</strong> — the AI assistant and receipt-image
            extraction (see §4).
          </li>
          <li>
            <strong className="font-medium">Cloudflare</strong> — web hosting and content delivery.
          </li>
          <li>
            <strong className="font-medium">Apple (APNs)</strong> — push notification delivery,
            only if you use the iOS app and allow notifications; receives your device&rsquo;s push
            token and the notification content, transiently, to deliver it.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">7. Data retention</h2>
        <p className="mt-2">
          Financial/ledger records (transactions, rent payments, generated reports) are retained
          for the life of your account, since they form your accounting and tax records — a filed
          report is a permanent snapshot by design. Tenant contact information is retained for as
          long as the tenant relationship is reflected in your account, or until an erasure request
          is honored (see §8) — even then, we retain the underlying lease/payment history for your
          accounting records, just not the tenant's contact details. If you delete your account, it
          enters a short, cancellable grace period, after which everything in it is permanently and
          irreversibly deleted, including from backups within their normal retention cycle. We keep
          a minimal record that a deletion happened, and when, containing no tenant or financial
          data, purely to demonstrate compliance.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">8. Your privacy rights</h2>
        <p className="mt-2">
          Depending on your state of residence, you may have rights under a state consumer privacy
          law (e.g. California's CCPA/CPRA, and similar laws in Colorado, Connecticut, Virginia,
          Texas, Oregon, Utah, and others) to know/access, correct, or delete your personal
          information, opt out of "sale" or "sharing" (we don't sell or share for advertising, so
          there is nothing to opt out of today), and be free from discrimination for exercising
          these rights.
        </p>
        <p className="mt-2">
          You can access or correct your account data, and delete your account (which starts a
          short grace period before permanent deletion), directly in Settings. You can anonymize a
          specific tenant's contact information from that tenant's profile, while your accounting
          records for that tenant's lease/payment history are retained.
        </p>
        <p className="mt-2">
          <strong className="font-medium">FCRA &amp; Fair Housing Act:</strong> 554 Properties does
          not provide tenant screening, credit checks, or background checks, and does not furnish
          or use "consumer reports." Our AI assistant does not make or influence any accept/deny
          decision about a rental applicant.
        </p>
      </section>

      <section id="tenants">
        <h2 className="text-base font-semibold text-ink">
          9. If you're a tenant, not a 554 Properties account holder
        </h2>
        <p className="mt-2">
          If your landlord uses 554 Properties, some of your personal information (name, contact
          info, lease terms, payment history) may be stored in their account. We don't have a
          direct relationship with you and can't act on your instructions directly — your landlord
          decides what's entered and is the right party to contact about your data. If you're
          unable to resolve a request with your landlord directly, contact us at{' '}
          <a href="mailto:privacy@554properties.com" className="text-brand underline">
            privacy@554properties.com
          </a>{' '}
          and we'll work with the account owner as required by applicable law.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">10. Children's privacy</h2>
        <p className="mt-2">
          The Service is intended for business use by adult landlords and property managers and is
          not directed at, nor knowingly used to collect information from, children under 16.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">11. Changes to this policy</h2>
        <p className="mt-2">
          We may update this policy from time to time. We'll update the "Last updated" date above
          and, for material changes, provide additional notice before the change takes effect.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">12. Contact us</h2>
        <p className="mt-2">
          Questions about this policy or your data:{' '}
          <a href="mailto:privacy@554properties.com" className="text-brand underline">
            privacy@554properties.com
          </a>
        </p>
      </section>
    </div>
  );
}
