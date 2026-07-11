# 554 Properties — Privacy Policy (DRAFT TEMPLATE)

> ## ⚠️ Attorney review required before use
> **This is an engineering-drafted template, not a finished legal document.** It was written from a direct audit of what the 554 Properties codebase actually collects, stores, and sends to third parties (see `docs/SECURITY_PRIVACY_AUDIT.md`) — it is grounded in fact, not boilerplate copied from another product. But it is **not legal advice** and has not been reviewed by an attorney. Before this is published or relied on for a real launch, it must be reviewed by a licensed attorney qualified in US privacy law (state privacy statutes, GLBA, FCRA, and any state where you have users) for accuracy, completeness, and enforceability. Bracketed items like `[LEGAL ENTITY NAME]` and `[JURISDICTION]` need real values an attorney or the business owner supplies — do not guess and fill these in yourself.

**Last updated:** [DATE] · **Effective date:** [DATE]

---

## 1. Who this policy covers and what "554 Properties" means here

554 Properties ("554 Properties," "we," "us," "our") provides software that helps independent landlords manage rental properties, tenants, leases, rent collection, bookkeeping, and reporting, including an AI assistant ("Roost") and, where enabled, bank-account transaction import via Plaid.

This policy describes how we handle personal information when you use the 554 Properties web application at app.554properties.com (the "Service"). It applies to:

- **You, the account owner** — the landlord or property manager who signs up for and uses the Service (referred to below as "you" or "the account owner").
- **Data about tenants, applicants, and other individuals** that you (the account owner) enter into the Service. For that data, **you are the data controller and we act as your service provider/processor** — we process it on your behalf, under your instructions, to provide the Service to you. If you are a tenant or former tenant whose information appears in a landlord's 554 Properties account, see [§9](#9-if-youre-a-tenant-not-a-554-properties-account-holder) below.

## 2. What we collect

Grounded in what the Service actually does (not a generic list):

### 2.1 Information you provide directly
- **Account/profile data:** name, email address, password (handled by our authentication provider, Supabase Auth — we never see or store your raw password), timezone, and account-level settings (tax rate assumption, tax year start month, rent grace period).
- **Tenant and lease data you enter:** tenant full name, email, phone number, free-text notes, lease terms (rent amount, dates, unit assignment), and co-tenant relationships.
- **Property data:** addresses, unit details, acquisition date/cost, notes.
- **Financial/transaction data:** every income and expense entry you record or confirm — amount, date, category, vendor name, and description — forms your ledger. This is the data source for every report (P&L, Schedule E, rent roll, etc.) the Service generates for you.
- **Documents you upload:** leases, receipts, insurance documents, inspection reports, notices, tax documents, or anything else you attach to a property, unit, tenant, lease, or transaction. Uploaded files may contain any personal information present in the document itself (e.g., a signed lease may contain a tenant's full legal name, or a receipt photo may incidentally show more than the vendor and amount).
- **Chat messages you send to the AI assistant ("Roost")** and any files (e.g., receipt photos) you submit to it.

### 2.2 Information from linked third-party accounts
- **Bank transaction data, only if you connect a bank account:** if you link a bank account through Plaid, we receive transaction-level data (date, amount, description, a bank-assigned transaction identifier) for transactions you choose to import into your ledger. **We never receive or store your online banking username or password** — Plaid handles that exchange and gives us a secure access token instead, which we encrypt before storing (see [§5](#5-how-we-protect-your-information)).

### 2.3 Information collected automatically
- **Usage and log data:** IP address, browser/device information, timestamps, and pages/actions used, collected through standard web server logging.
- **Audit trail:** every write action that touches money or tenant data (creating a transaction, recording a rent payment, sending a reminder, generating a report, connecting/disconnecting a bank account, etc.) is recorded in an internal audit log with who/what/when, for your own record-keeping and for security investigation purposes. This log is not shared externally.
- **Push notification device token, only if you use the iOS app and allow notifications:** an Apple-issued device token that lets us send push notifications (e.g., "rent received", late-rent alerts) to your device through the Apple Push Notification service (APNs). The token identifies your device for notification delivery only — it contains no personal information and cannot be used to read anything on your device. It is stored against your account, refreshed when you open the app, deleted when you sign out or when Apple reports the device is no longer registered, and shared with no one other than Apple (as required to deliver the notification; see [§6](#6-who-we-share-information-with-sub-processors)). Notification content is generated from your own account data.
- **Face ID / biometrics — not collected:** if you enable the optional Face ID lock in the iOS app, authentication happens entirely on your device through Apple's APIs. We never receive, store, or have access to any biometric data; the app only learns that the unlock succeeded.

### 2.4 What we do **not** currently collect
As of this policy's drafting, 554 Properties does not perform tenant credit checks, background checks, or any consumer-report-based screening, and does not use AI to make or influence any accept/deny decision about a rental applicant or tenant. If that changes, this policy — and applicable law (see [§8.3](#83-fair-credit-reporting-act-fcra--fair-housing-act-fha)) — will be updated accordingly before any such feature launches.

## 3. How we use information

We use the information above only to operate, maintain, and improve the Service, specifically to:

- Authenticate you and secure your account.
- Store and display your properties, tenants, leases, transactions, and documents back to you.
- Calculate the derived figures the Service shows you (cash flow, rent-collection status, tax set-aside estimates, reports) — always from your own data, scoped to your account only.
- Power the AI assistant's answers to your questions, using your own account data as context (see [§4](#4-the-ai-assistant-and-what-it-sends-to-anthropic) for specifics).
- Import bank transactions you've asked us to import, via Plaid.
- Send you service-related communications (e.g., password reset emails via Supabase, or — for actions you configure — rent reminder emails and report emails on your behalf to your tenants/accountant).
- Maintain security, investigate abuse, and enforce our Terms of Service.
- Comply with legal obligations.

**We do not sell your personal information or your tenants' personal information, and we do not share it with third parties for their own advertising purposes.** The only parties we share data with are the service providers described in [§4](#4-the-ai-assistant-and-what-it-sends-to-anthropic) and [§6](#6-who-we-share-information-with-sub-processors), acting on our behalf to provide the Service to you.

## 4. The AI assistant and what it sends to Anthropic

The in-app assistant ("Roost") is built on Claude, a large language model provided by Anthropic. This section exists because we believe you should know exactly what leaves our infrastructure when you use it:

- **What's sent:** when you ask the assistant a question, it may call internal tools to look up your own portfolio data — this can include tenant names, contact info, exact dollar amounts, vendor names, and lease terms — and that data, along with your message, is sent to Anthropic's API to generate a response. The assistant only ever accesses data belonging to your own account.
- **Receipt scanning:** if you use the "snap a receipt" feature and an AI-powered scan is enabled, the actual receipt image is sent to Anthropic's API to extract the vendor, amount, and date.
- **What Anthropic does with it:** under the commercial API terms we operate under, Anthropic does not use your data to train its models. [We are in the process of confirming / have confirmed — ATTORNEY & PRODUCT TO CONFIRM AND UPDATE] whether a zero-data-retention arrangement applies to the specific model and product tier in use; absent that, Anthropic may retain inputs/outputs for a limited window as described in its own API data-handling terms. We encourage you to review Anthropic's privacy terms directly at anthropic.com.
- **Deterministic "mock mode":** in some environments (e.g., demos, local development) the assistant runs entirely offline against a deterministic script and never contacts Anthropic at all. This policy's AI section describes the real-mode behavior used in production.
- **Your control:** action-taking suggestions from the assistant (e.g., "record this payment," "send this reminder") are never executed automatically — the assistant can only propose an action, which you must explicitly click to confirm, and which then runs through the same code path and audit trail as if you'd done it directly in the app.

## 5. How we protect your information

- All traffic to the Service is encrypted in transit (HTTPS/TLS).
- Passwords are managed entirely by our authentication provider (Supabase Auth) — we never see or store a raw password.
- Bank-account access tokens (from Plaid) are encrypted at rest before storage, using a dedicated encryption key that is never checked into source control and is provisioned separately per environment.
- Every account's data is logically separated from every other account's — the application enforces that a request under one account can never read or write another account's properties, tenants, transactions, or documents.
- Uploaded files are validated against their actual content (not just a client-supplied label) before being accepted, to reduce the risk of disguised or malicious file uploads.
- We do not currently sell, and have no plans to sell, personal information to data brokers or advertisers.

No system is 100% secure, and we can't guarantee absolute security. If we experience a data breach affecting your personal information, we will notify you and any required regulators in accordance with applicable law (see [§8.4](#84-data-breach-notification)).

## 6. Who we share information with (sub-processors)

We use the following service providers to operate 554 Properties. Each processes data only as necessary to provide their specific function to us, under a contract that limits their use of your data to that purpose.

| Provider | What they do | What they receive |
|---|---|---|
| **Supabase** | Database hosting, authentication, and (where enabled) file storage | Effectively all data you enter into the Service, since it's our database/infrastructure provider |
| **Plaid** | Bank-account linking and transaction data aggregation, only if you connect a bank account | Your bank login (handled directly by Plaid, never by us), and the transaction data it returns to us |
| **Anthropic** | AI assistant (chat) and receipt-image extraction | See [§4](#4-the-ai-assistant-and-what-it-sends-to-anthropic) |
| **Cloudflare** | Web hosting, content delivery, and edge security for the Service | Standard web request metadata (IP address, request headers) as part of serving the application |
| **Apple (APNs)** | Push notification delivery, only if you use the iOS app and allow notifications | Your device's push token and the notification content (title/body, e.g. "Rent received"), transiently, to deliver it to your device |

We do not have signed Data Processing Agreements confirmed with every provider above as of this draft — **[ATTORNEY/PRODUCT: confirm DPAs are in place with Supabase, Plaid, and Anthropic before this policy is published, and update this table if the provider list changes.]**

## 7. Data retention

- **Financial/ledger records** (transactions, rent payments, generated reports) are retained for the life of your account and are not automatically deleted, because they form your accounting and tax records — a filed report is a permanent snapshot by design, so historical figures don't silently change.
- **Tenant contact information** is retained for as long as the tenant relationship is reflected in your account, or until you request its erasure (see [§8.2](#82-how-to-exercise-your-rights)) — noting that even after an erasure request, we retain the underlying lease/payment history (not the tenant's contact details) for your accounting records.
- **If you delete your account**, it enters a short, cancellable grace period, after which it and everything in it (properties, tenants, transactions, documents, reports) is permanently and irreversibly deleted, including from our backups within their normal retention cycle. We keep a minimal record (that a deletion happened, and when) purely to demonstrate compliance with deletion requests — that record contains no tenant or financial data.

## 8. Your privacy rights

### 8.1 What rights may apply to you

Depending on your state of residence, you may have rights under a state consumer privacy law (for example, California's CCPA/CPRA, and similar laws in Colorado, Connecticut, Virginia, Texas, Oregon, Utah, and others) to:

- **Know/access** the personal information we hold about you.
- **Correct** inaccurate personal information.
- **Delete** your personal information (subject to exceptions, such as our need to retain financial records for legal/tax purposes).
- **Opt out of the "sale" or "sharing"** of personal information — as noted above, we do not sell or share personal information with third parties for advertising, so there is nothing to opt out of today.
- **Non-discrimination** for exercising any of these rights.

**[ATTORNEY: confirm which specific state laws currently apply to this business based on revenue/user-volume thresholds, and add any required disclosures — e.g., Global Privacy Control recognition — that apply once thresholds are met. Texas's law in particular has no revenue threshold.]**

### 8.2 How to exercise your rights

- **Access or correct your own account data:** available directly in the app's Settings page, or by contacting us at the email below.
- **Delete your account and all its data:** available directly in Settings ("Delete account"), which starts a short grace period before permanent deletion, or by contacting us at the email below.
- **Anonymize a specific tenant's personal information** (while retaining the underlying lease/financial history for your own accounting records): available to you, the account owner, as the person who entered that data, via the tenant's profile in the app.
- **If you are a tenant** (not a 554 Properties account holder yourself) and want to exercise a privacy right over data a landlord has entered about you in this Service, see [§9](#9-if-youre-a-tenant-not-a-554-properties-account-holder).

Contact: **[PRIVACY CONTACT EMAIL]**

### 8.3 Fair Credit Reporting Act (FCRA) & Fair Housing Act (FHA)

554 Properties does not, as of this policy, provide tenant screening, credit checks, or background checks, and does not furnish or use "consumer reports" as defined by the FCRA. If we add such a feature in the future, this policy and our compliance obligations (including FCRA adverse-action notice requirements) will be updated before launch. Similarly, our AI assistant does not make or influence any accept/deny decision about a rental applicant — it assists the landlord with their own existing tenants and financial data only.

### 8.4 Data breach notification

If a breach of your personal information occurs, we will notify affected individuals and, where required, state regulators, in accordance with the breach notification law(s) of the state(s) where affected individuals reside. **[ATTORNEY: insert specific notification-timeline commitments if the business wants to commit to a number faster than the applicable legal minimum.]**

## 9. If you're a tenant, not a 554 Properties account holder

If your landlord uses 554 Properties to manage their properties, some of your personal information (name, contact info, lease terms, payment history) may be stored in their 554 Properties account. **We do not have a direct relationship with you and cannot act on your instructions directly** — your landlord is the one who decides what information about you is entered into the Service and is the appropriate party to contact for any request about your data (access, correction, deletion). If you're unable to resolve a request with your landlord directly, you may contact us at **[PRIVACY CONTACT EMAIL]** and we will work with the account owner as appropriate and as required by applicable law.

## 10. Children's privacy

The Service is intended for business use by adult landlords and property managers and is not directed at, nor knowingly used to collect information from, children under 16.

## 11. Changes to this policy

We may update this policy from time to time. We'll update the "Last updated" date above and, for material changes, provide additional notice (e.g., an in-app notice or email) before the change takes effect.

## 12. Contact us

**[LEGAL ENTITY NAME]**
[MAILING ADDRESS]
**[PRIVACY CONTACT EMAIL]**
