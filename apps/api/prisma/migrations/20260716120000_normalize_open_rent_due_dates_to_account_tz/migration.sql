-- WS4 — timezone-aware period math.
--
-- Open (due/processing) rent charges were materialized with a UTC-midnight
-- dueDate (e.g. 2026-07-01 00:00:00). Now that days-late is measured on the
-- account's local calendar, a UTC-midnight dueDate reads ±1 day off for a
-- non-UTC landlord. Rewrite each open charge's dueDate to the SAME calendar
-- day at that account's local midnight, expressed as the UTC instant we store.
--
-- Only paid/failed rows are history; leaving their dueDates alone. Only rows
-- still at exact UTC midnight are touched (the guard below), so this is
-- idempotent in effect: a second run is a no-op for already-normalized rows
-- (their dueDate no longer sits at 00:00:00 for a non-UTC account), and the
-- transform is the identity for UTC-offset-0 accounts.
--
-- dueDate is `timestamp without time zone` holding the UTC wall clock, so every
-- expression here is session-timezone-independent:
--   rp."dueDate"::date::timestamp        -> the stored calendar day at 00:00
--   ... AT TIME ZONE a."timezone"         -> that local midnight as a timestamptz
--   ... AT TIME ZONE 'UTC'                -> its UTC wall clock, back to timestamp
-- and the guard date_trunc('day', rp."dueDate") zeroes the clock without any tz.
UPDATE "RentPayment" AS rp
SET "dueDate" = ((rp."dueDate"::date::timestamp AT TIME ZONE a."timezone") AT TIME ZONE 'UTC')
FROM "Lease" AS l, "Unit" AS u, "Property" AS p, "Account" AS a
WHERE rp."leaseId" = l."id"
  AND l."unitId" = u."id"
  AND u."propertyId" = p."id"
  AND p."accountId" = a."id"
  AND rp."status" IN ('due', 'processing')
  AND rp."dueDate" = date_trunc('day', rp."dueDate");
