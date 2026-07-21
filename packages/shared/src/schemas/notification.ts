import { z } from 'zod';

// Per-category delivery toggles for scheduler-driven notifications. Stored
// sparse (User.notificationPrefsJson / Account.notificationPrefsJson) and
// merged over DEFAULT_NOTIFICATION_PREFS on read, so new categories get safe
// defaults without a data migration.
export const ChannelPrefsSchema = z.object({ push: z.boolean(), email: z.boolean() });
export type ChannelPrefs = z.infer<typeof ChannelPrefsSchema>;

// GET /settings/notifications response AND PUT /settings/notifications body
// (full replace).
export const NotificationPrefsSchema = z.object({
  warning_insights: ChannelPrefsSchema,
  weekly_brief: ChannelPrefsSchema,
  monthly_review: ChannelPrefsSchema,
});
export type NotificationPrefs = z.infer<typeof NotificationPrefsSchema>;

// Conservative defaults (production has real users): all email off, and only
// the pushes that already happened today (warning insights) plus the new
// weekly brief default on — a deploy must not start emailing/pushing new
// things without opt-in.
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  warning_insights: { push: true, email: false }, // preserves today's behavior exactly
  weekly_brief: { push: true, email: false }, // email opt-in
  monthly_review: { push: false, email: false }, // no new default noise for existing users
};
