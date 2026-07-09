// Every key seed figure lives here as a named constant, imported by BOTH
// prisma/seed.ts and the tests (ARCHITECTURE "Risks": seed-number drift).
// Change a number here and the dashboard tests change with it.
import { slugify } from '../src/lib/strings';

// ── demo account ─────────────────────────────────────────────────────────────
export const DEMO_EMAIL = 'demo@hearth.app';
export const DEMO_NAME = 'Sam Landlord';
export const DEMO_TIMEZONE = 'America/New_York';
export const DEMO_TAX_RATE_PCT = 20;
export const DEMO_GRACE_DAYS = 0;

// ── portfolio (§10: 9 properties, 14 units, all occupied) ────────────────────
export interface SeedUnitSpec {
  label: string;
  rentCents: number;
  marketRentCents: number;
  bedrooms: number;
  bathrooms: number;
  tenantName: string;
  tenantEmail: string;
  /** 'online' | 'manual' → paid this month; number → days late (unpaid). */
  payment: 'online' | 'manual' | number;
  leaseStartMonthsAgo: number;
  leaseEndDaysFromToday: number;
  esignSigned?: boolean;
}

export interface SeedPropertySpec {
  key: string;
  addressLine1: string;
  city: string;
  state: string;
  zip: string;
  acquisitionYear: number;
  acquisitionCostCents: number;
  units: SeedUnitSpec[];
}

export const OKAFOR_NAME = 'T. Okafor';
export const PARK_NAME = 'D. Park';
export const CHEN_NAME = 'M. Chen';
export const NOVAK_NAME = 'S. Novak';
export const BIRCH_ADDRESS = '5 Birch Ln';

export const OKAFOR_DAYS_LATE = 6;
export const PARK_DAYS_LATE = 3;
export const OKAFOR_RENT_CENTS = 115000;
export const PARK_RENT_CENTS = 98500;
export const CHEN_LEASE_END_DAYS = 45;
export const NOVAK_LEASE_END_DAYS = 58;

const email = (name: string) => `${slugify(name)}@example.com`;

export const SEED_PROPERTIES: SeedPropertySpec[] = [
  {
    key: 'maple', addressLine1: '12 Maple St', city: 'Springfield', state: 'IL', zip: '62704',
    acquisitionYear: 2019, acquisitionCostCents: 21500000,
    units: [
      { label: 'Main', rentCents: 125000, marketRentCents: 129500, bedrooms: 3, bathrooms: 2, tenantName: 'J. Rivera', tenantEmail: email('J. Rivera'), payment: 'online', leaseStartMonthsAgo: 18, leaseEndDaysFromToday: 320 },
    ],
  },
  {
    key: 'oak', addressLine1: '88 Oak Ave', city: 'Springfield', state: 'IL', zip: '62704',
    acquisitionYear: 2018, acquisitionCostCents: 41200000,
    units: [
      { label: 'A', rentCents: 87500, marketRentCents: 91000, bedrooms: 2, bathrooms: 1, tenantName: 'K. Whitfield', tenantEmail: email('K. Whitfield'), payment: 'online', leaseStartMonthsAgo: 14, leaseEndDaysFromToday: 400 },
      { label: 'B', rentCents: 87500, marketRentCents: 91000, bedrooms: 2, bathrooms: 1, tenantName: 'A. Osei', tenantEmail: email('A. Osei'), payment: 'manual', leaseStartMonthsAgo: 26, leaseEndDaysFromToday: 210 },
      { label: 'C', rentCents: 90000, marketRentCents: 93000, bedrooms: 2, bathrooms: 1.5, tenantName: 'R. Delgado', tenantEmail: email('R. Delgado'), payment: 'online', leaseStartMonthsAgo: 9, leaseEndDaysFromToday: 500 },
    ],
  },
  {
    key: 'birch', addressLine1: BIRCH_ADDRESS, city: 'Springfield', state: 'IL', zip: '62703',
    acquisitionYear: 2021, acquisitionCostCents: 29800000,
    units: [
      { label: '1', rentCents: PARK_RENT_CENTS, marketRentCents: 101500, bedrooms: 2, bathrooms: 1, tenantName: PARK_NAME, tenantEmail: email(PARK_NAME), payment: PARK_DAYS_LATE, leaseStartMonthsAgo: 12, leaseEndDaysFromToday: 180 },
      { label: '2', rentCents: 94000, marketRentCents: 96500, bedrooms: 2, bathrooms: 1, tenantName: 'L. Nguyen', tenantEmail: email('L. Nguyen'), payment: 'online', leaseStartMonthsAgo: 20, leaseEndDaysFromToday: 365 },
    ],
  },
  {
    key: 'cedar', addressLine1: '21 Cedar Ct', city: 'Springfield', state: 'IL', zip: '62702',
    acquisitionYear: 2020, acquisitionCostCents: 19900000,
    units: [
      { label: 'Main', rentCents: OKAFOR_RENT_CENTS, marketRentCents: 119500, bedrooms: 3, bathrooms: 1.5, tenantName: OKAFOR_NAME, tenantEmail: email(OKAFOR_NAME), payment: OKAFOR_DAYS_LATE, leaseStartMonthsAgo: 10, leaseEndDaysFromToday: 270, esignSigned: true },
    ],
  },
  {
    key: 'pine', addressLine1: '9 Pine Rd', city: 'Springfield', state: 'IL', zip: '62702',
    acquisitionYear: 2022, acquisitionCostCents: 24600000,
    units: [
      { label: '1', rentCents: 79500, marketRentCents: 82500, bedrooms: 1, bathrooms: 1, tenantName: 'H. Brooks', tenantEmail: email('H. Brooks'), payment: 'manual', leaseStartMonthsAgo: 16, leaseEndDaysFromToday: 430 },
      { label: '2', rentCents: 81500, marketRentCents: 84000, bedrooms: 1, bathrooms: 1, tenantName: NOVAK_NAME, tenantEmail: email(NOVAK_NAME), payment: 'online', leaseStartMonthsAgo: 11, leaseEndDaysFromToday: NOVAK_LEASE_END_DAYS },
    ],
  },
  {
    key: 'willow', addressLine1: '140 Willow Way', city: 'Springfield', state: 'IL', zip: '62711',
    acquisitionYear: 2023, acquisitionCostCents: 20100000,
    units: [
      { label: 'Main', rentCents: 117500, marketRentCents: 122000, bedrooms: 3, bathrooms: 2, tenantName: CHEN_NAME, tenantEmail: email(CHEN_NAME), payment: 'online', leaseStartMonthsAgo: 11, leaseEndDaysFromToday: CHEN_LEASE_END_DAYS },
    ],
  },
  {
    key: 'elm', addressLine1: '7 Elm St', city: 'Springfield', state: 'IL', zip: '62701',
    acquisitionYear: 2018, acquisitionCostCents: 14700000,
    units: [
      { label: 'Main', rentCents: 95000, marketRentCents: 97500, bedrooms: 2, bathrooms: 1, tenantName: 'P. Iyer', tenantEmail: email('P. Iyer'), payment: 'online', leaseStartMonthsAgo: 24, leaseEndDaysFromToday: 240 },
    ],
  },
  {
    key: 'aspen', addressLine1: '310 Aspen Dr', city: 'Springfield', state: 'IL', zip: '62712',
    acquisitionYear: 2024, acquisitionCostCents: 23900000,
    units: [
      { label: '1', rentCents: 78000, marketRentCents: 80500, bedrooms: 1, bathrooms: 1, tenantName: 'C. Marsh', tenantEmail: email('C. Marsh'), payment: 'manual', leaseStartMonthsAgo: 8, leaseEndDaysFromToday: 380 },
      { label: '2', rentCents: 79000, marketRentCents: 81000, bedrooms: 1, bathrooms: 1, tenantName: 'E. Fontaine', tenantEmail: email('E. Fontaine'), payment: 'online', leaseStartMonthsAgo: 8, leaseEndDaysFromToday: 300 },
    ],
  },
  {
    key: 'juniper', addressLine1: '55 Juniper Blvd', city: 'Springfield', state: 'IL', zip: '62711',
    acquisitionYear: 2021, acquisitionCostCents: 26400000,
    units: [
      { label: 'Main', rentCents: 141500, marketRentCents: 146000, bedrooms: 4, bathrooms: 2.5, tenantName: 'G. Almeida', tenantEmail: email('G. Almeida'), payment: 'online', leaseStartMonthsAgo: 30, leaseEndDaysFromToday: 460 },
    ],
  },
];

// ── pinned KPI figures (asserted by seed AND tests) ──────────────────────────
export const TOTAL_UNITS = 14;
export const PAID_UNITS = 12;
export const RENT_COLLECTED_PCT = 86; // round(12/14 × 100)
export const RENT_ROLL_CENTS = 1369500; // $13,695/mo
export const COLLECTED_MTD_CENTS = 1156000; // roll − Okafor − Park
export const OUTSTANDING_MTD_CENTS = OKAFOR_RENT_CENTS + PARK_RENT_CENTS; // 213500
export const EXPENSES_MTD_CENTS = 311000; // $3,110 itemized below
export const NET_CASHFLOW_MTD_CENTS = COLLECTED_MTD_CENTS - EXPENSES_MTD_CENTS; // 845000
export const TAX_SET_ASIDE_CURRENT_CENTS = 169000; // 845000 × 20%
export const TAX_SET_ASIDE_TARGET_CENTS = 270000; // 450000 × 3 × 20%
export const AVG_TRAILING_NET_CENTS = 450000; // trailing 6 full months

// ── current-month expenses = $3,110 (§10, itemized) ──────────────────────────
export interface SeedExpenseSpec {
  categoryName: string;
  amountCents: number;
  vendor: string;
  description: string;
  propertyKey: string | null; // null = portfolio-level
  day: number; // day of month (clamped to today for the current month)
}

export const CURRENT_MONTH_EXPENSES: SeedExpenseSpec[] = [
  { categoryName: 'Repairs', amountCents: 48000, vendor: 'Reyes Plumbing', description: 'Plumbing repair — Unit B bathroom', propertyKey: 'oak', day: 2 },
  { categoryName: 'Utilities', amountCents: 64000, vendor: 'City of Springfield Utilities', description: 'Water & electric service', propertyKey: 'birch', day: 2 },
  { categoryName: 'Insurance', amountCents: 78000, vendor: 'Granite State Insurance', description: 'Landlord policy premium', propertyKey: null, day: 1 },
  { categoryName: 'Landscaping', amountCents: 31000, vendor: 'GreenScape Co.', description: 'Monthly grounds service', propertyKey: 'maple', day: 1 },
  { categoryName: 'Cleaning & Maintenance', amountCents: 22000, vendor: 'Sparkle Cleaning', description: 'Common area cleaning', propertyKey: 'aspen', day: 2 },
  { categoryName: 'Supplies', amountCents: 18000, vendor: 'HD Supply', description: 'Filters and hardware', propertyKey: 'pine', day: 3 },
  { categoryName: 'HOA Fees', amountCents: 50000, vendor: 'Juniper Blvd HOA', description: 'Monthly HOA dues', propertyKey: 'juniper', day: 1 },
];

// ── trailing 6 full months (oldest first: M−6 … M−1) ─────────────────────────
// Monthly income is the full rent roll; expense totals are pinned so that
// avg net = (1369500 − avg expenses) = exactly $4,500.
export const TRAILING_EXPENSE_TOTALS_CENTS = [948000, 891000, 965000, 873000, 924000, 916000];

/** Recurring every trailing month (portfolio unless a propertyKey is set). */
export const TRAILING_FIXED_EXPENSES: SeedExpenseSpec[] = [
  { categoryName: 'Insurance', amountCents: 78000, vendor: 'Granite State Insurance', description: 'Landlord policy premium', propertyKey: null, day: 2 },
  { categoryName: 'Property Management', amountCents: 68000, vendor: 'Keystone Property Management', description: 'Management fee', propertyKey: null, day: 3 },
  { categoryName: 'Mortgage Interest', amountCents: 320000, vendor: 'First Federal Bank', description: 'Mortgage interest', propertyKey: null, day: 5 },
  { categoryName: 'HOA Fees', amountCents: 50000, vendor: 'Juniper Blvd HOA', description: 'Monthly HOA dues', propertyKey: 'juniper', day: 6 },
  { categoryName: 'Landscaping', amountCents: 31000, vendor: 'GreenScape Co.', description: 'Monthly grounds service', propertyKey: null, day: 8 },
  { categoryName: 'Cleaning & Maintenance', amountCents: 22000, vendor: 'Sparkle Cleaning', description: 'Common area cleaning', propertyKey: null, day: 10 },
  { categoryName: 'Supplies', amountCents: 18000, vendor: 'HD Supply', description: 'Filters and hardware', propertyKey: null, day: 12 },
];

/**
 * Utilities at 5 Birch Ln per trailing month (M−6 … M−1). The 120/130 → 640
 * step in the last three months is what makes the current month's $640 fire
 * the expense_spike rule ($640 > 125% × avg($120, $130, $640)).
 */
export const BIRCH_UTILITIES_BY_MONTH_CENTS = [34000, 35000, 33000, 12000, 13000, 64000];

/** One-off lines per trailing month (index 0 = M−6 … index 5 = M−1). */
export const TRAILING_EXTRA_EXPENSES: SeedExpenseSpec[][] = [
  [
    { categoryName: 'Property Taxes', amountCents: 190000, vendor: 'Springfield County Treasurer', description: 'Property tax installment', propertyKey: null, day: 15 },
    { categoryName: 'Repairs', amountCents: 85000, vendor: 'Reyes Plumbing', description: 'Water heater valve replacement', propertyKey: 'oak', day: 14 },
    { categoryName: 'Legal & Professional', amountCents: 52000, vendor: 'Hale & Co. CPA', description: 'Bookkeeping', propertyKey: null, day: 20 },
  ],
  [
    { categoryName: 'Property Taxes', amountCents: 190000, vendor: 'Springfield County Treasurer', description: 'Property tax installment', propertyKey: null, day: 15 },
    { categoryName: 'Repairs', amountCents: 43000, vendor: 'Apex Handyman', description: 'Deck board replacement', propertyKey: 'pine', day: 14 },
    { categoryName: 'Legal & Professional', amountCents: 36000, vendor: 'Hale & Co. CPA', description: 'Bookkeeping', propertyKey: null, day: 20 },
  ],
  [
    { categoryName: 'Property Taxes', amountCents: 190000, vendor: 'Springfield County Treasurer', description: 'Property tax installment', propertyKey: null, day: 15 },
    { categoryName: 'Repairs', amountCents: 112000, vendor: 'Rapid Water Heater Co.', description: 'Water heater replacement', propertyKey: 'elm', day: 18 },
    { categoryName: 'Legal & Professional', amountCents: 43000, vendor: 'Hale & Co. CPA', description: 'Bookkeeping + filing prep', propertyKey: null, day: 20 },
  ],
  [
    { categoryName: 'Property Taxes', amountCents: 190000, vendor: 'Springfield County Treasurer', description: 'Property tax installment', propertyKey: null, day: 15 },
    { categoryName: 'Repairs', amountCents: 54000, vendor: 'Apex Handyman', description: 'Gutter and downspout repair', propertyKey: 'cedar', day: 14 },
    { categoryName: 'Legal & Professional', amountCents: 30000, vendor: 'Hale & Co. CPA', description: 'Bookkeeping', propertyKey: null, day: 20 },
  ],
  [
    { categoryName: 'Property Taxes', amountCents: 190000, vendor: 'Springfield County Treasurer', description: 'Property tax installment', propertyKey: null, day: 15 },
    { categoryName: 'Repairs', amountCents: 98000, vendor: 'Reyes Plumbing', description: 'Main line snaking + fixture swap', propertyKey: 'willow', day: 14 },
    { categoryName: 'Legal & Professional', amountCents: 36000, vendor: 'Hale & Co. CPA', description: 'Bookkeeping', propertyKey: null, day: 20 },
  ],
  [
    // M−1 carries the wireframe comparison anchors: roof repair $1,200 at
    // 12 Maple St and utilities $640 (the Birch series above).
    { categoryName: 'Repairs', amountCents: 120000, vendor: 'Summit Roofing', description: 'Roof repair — flashing and shingles', propertyKey: 'maple', day: 14 },
    { categoryName: 'Repairs', amountCents: 62000, vendor: 'Reyes Plumbing', description: 'Kitchen sink and disposal', propertyKey: 'elm', day: 18 },
    { categoryName: 'Legal & Professional', amountCents: 83000, vendor: 'Hale & Co. CPA', description: 'Mid-year tax planning session', propertyKey: null, day: 20 },
  ],
];

// ── review queue (3 pending bank transactions) ───────────────────────────────
export const REVIEW_QUEUE_ITEMS = [
  { description: 'HD SUPPLY #443', vendor: 'HD Supply', amountCents: 16400, suggestedCategoryName: 'Supplies', confidence: 0.84, daysAgo: 2 },
  { description: 'CITY OF SPRINGFIELD WATER', vendor: 'City of Springfield', amountCents: 12800, suggestedCategoryName: 'Utilities', confidence: 0.91, daysAgo: 4 },
  { description: 'AMZN Mktp US*7Y42Q', vendor: 'Amazon', amountCents: 7600, suggestedCategoryName: 'Supplies', confidence: 0.55, daysAgo: 1 },
];

// ── categories (system-seeded, IRS Schedule E aligned) ───────────────────────
export const SEED_CATEGORIES: Array<{
  name: string;
  type: 'income' | 'expense';
  irsScheduleELine: string;
}> = [
  { name: 'Rent', type: 'income', irsScheduleELine: 'Line 3 – Rents received' },
  { name: 'Late Fees', type: 'income', irsScheduleELine: 'Line 3 – Rents received' },
  { name: 'Other Income', type: 'income', irsScheduleELine: 'Line 3 – Rents received' },
  { name: 'Repairs', type: 'expense', irsScheduleELine: 'Line 14 – Repairs' },
  { name: 'Capital Improvements', type: 'expense', irsScheduleELine: 'Line 18 – Depreciation (capitalized)' },
  { name: 'Utilities', type: 'expense', irsScheduleELine: 'Line 17 – Utilities' },
  { name: 'Insurance', type: 'expense', irsScheduleELine: 'Line 9 – Insurance' },
  { name: 'Property Taxes', type: 'expense', irsScheduleELine: 'Line 16 – Taxes' },
  { name: 'Mortgage Interest', type: 'expense', irsScheduleELine: 'Line 12 – Mortgage interest' },
  { name: 'Landscaping', type: 'expense', irsScheduleELine: 'Line 7 – Cleaning and maintenance' },
  { name: 'Cleaning & Maintenance', type: 'expense', irsScheduleELine: 'Line 7 – Cleaning and maintenance' },
  { name: 'Supplies', type: 'expense', irsScheduleELine: 'Line 15 – Supplies' },
  { name: 'HOA Fees', type: 'expense', irsScheduleELine: 'Line 19 – Other' },
  { name: 'Property Management', type: 'expense', irsScheduleELine: 'Line 11 – Management fees' },
  { name: 'Legal & Professional', type: 'expense', irsScheduleELine: 'Line 10 – Legal and other professional fees' },
  { name: 'Travel', type: 'expense', irsScheduleELine: 'Line 6 – Auto and travel' },
];

// ── seeded documents (names/types pinned; asserted by documents.test.ts) ─────
export const SEED_DOCUMENTS = {
  /** Attached to the first seeded property (SEED_PROPERTIES[0], 'maple'). */
  insurancePolicy: { name: 'Insurance policy — 2026.pdf', type: 'insurance' },
  /** Attached to the Okafor lease (esignEnvelopeId 'env_mock_seed_okafor'). */
  signedLease: { name: 'Signed lease agreement.pdf', type: 'lease' },
} as const;

// ── expected insight dedupeKeys for the current period ───────────────────────
export function expectedInsightDedupeKeys(period: string): {
  lateRent: string;
  expenseSpike: string;
  renewalWindow: string;
} {
  return {
    lateRent: `late_rent:${slugify(OKAFOR_NAME)}:${period}`,
    expenseSpike: `expense_spike:${slugify('Utilities')}:${slugify(BIRCH_ADDRESS)}:${period}`,
    renewalWindow: `renewal_window:${period}`,
  };
}
