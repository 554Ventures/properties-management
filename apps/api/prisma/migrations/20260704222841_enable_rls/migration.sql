-- Defense in depth: the API's Prisma connection uses the privileged `postgres`
-- role, which bypasses RLS entirely, so this does not change app behavior.
-- It closes Supabase's "RLS disabled on public table" advisory by denying
-- PostgREST access (anon/authenticated roles) to every table by default,
-- since this app never queries Supabase's data API directly (see
-- docs/property-app-deployment-plan.md §7).
ALTER TABLE "public"."Account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Property" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Unit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Tenant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Lease" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."LeaseTenant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Category" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Transaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."RentPayment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Report" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Insight" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ChatSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ChatMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Integration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."AuditLog" ENABLE ROW LEVEL SECURITY;

-- _prisma_migrations is engine-managed (not a schema.prisma model) and does
-- not exist yet in a fresh shadow/test database at the point this file
-- applies, so guard it rather than a bare ALTER TABLE.
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE "public"."_prisma_migrations" ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;
