// F2 notification prefs + category routing: GET/PUT /settings/notifications
// self-service round-trip (demo mode = account-level store), corrupt-JSON
// degradation, notifyCategory honoring per-user email/push toggles with
// null-userId devices following the owner, never-throw on adapter failure,
// and registerDevice stamping/re-stamping userId. Throwaway accounts are
// cleaned up in afterAll so later files see only seed data.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_NOTIFICATION_PREFS, NotificationPrefsSchema } from '@hearth/shared';
import { buildApp } from '../app';
import { resetMockEmail, sentEmails } from '../integrations/mock/mock-email';
import { resetMockPush, sentPushes } from '../integrations/mock/mock-push';
import { prisma } from '../lib/prisma';
import { getDemoAccountId } from '../plugins/auth';
import * as notificationService from '../services/notification.service';
import * as pushService from '../services/push.service';

let app: FastifyInstance;
let demoAccountId: string;

const TOKEN_PREFIX = 'notif_test_';
const EMAIL_DOMAIN = '@notiftest.example';

beforeAll(async () => {
  app = await buildApp();
  demoAccountId = await getDemoAccountId();
});

afterAll(async () => {
  // Restore the demo account's pristine (empty-overrides) store.
  await prisma.account.update({
    where: { id: demoAccountId },
    data: { notificationPrefsJson: '{}' },
  });
  await prisma.pushDevice.deleteMany({ where: { token: { startsWith: TOKEN_PREFIX } } });
  await prisma.account.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
  await app.close();
});

beforeEach(() => {
  resetMockEmail();
  resetMockPush();
});

describe('GET/PUT /settings/notifications (demo mode = account-level store)', () => {
  it('returns the defaults when nothing is stored', async () => {
    await prisma.account.update({
      where: { id: demoAccountId },
      data: { notificationPrefsJson: '{}' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/settings/notifications' });
    expect(res.statusCode).toBe(200);
    expect(NotificationPrefsSchema.parse(res.json())).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it('PUT round-trips a full replace', async () => {
    const updated = {
      warning_insights: { push: false, email: true },
      weekly_brief: { push: true, email: true },
      monthly_review: { push: true, email: false },
    };
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/notifications',
      payload: updated,
    });
    expect(put.statusCode).toBe(200);
    expect(NotificationPrefsSchema.parse(put.json())).toEqual(updated);

    const get = await app.inject({ method: 'GET', url: '/api/v1/settings/notifications' });
    expect(NotificationPrefsSchema.parse(get.json())).toEqual(updated);

    // Restore.
    await prisma.account.update({
      where: { id: demoAccountId },
      data: { notificationPrefsJson: '{}' },
    });
  });

  it('rejects a partial body (full replace contract)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/notifications',
      payload: { weekly_brief: { push: true, email: true } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('corrupt stored JSON degrades to defaults, never a 500', async () => {
    await prisma.account.update({
      where: { id: demoAccountId },
      data: { notificationPrefsJson: 'not-json{{{' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/settings/notifications' });
    expect(res.statusCode).toBe(200);
    expect(NotificationPrefsSchema.parse(res.json())).toEqual(DEFAULT_NOTIFICATION_PREFS);
    await prisma.account.update({
      where: { id: demoAccountId },
      data: { notificationPrefsJson: '{}' },
    });
  });
});

describe('notifyCategory (per-user routing)', () => {
  let accountId: string;
  let ownerId: string;
  let memberId: string;
  const ownerToken = `${TOKEN_PREFIX}owner`;
  const memberToken = `${TOKEN_PREFIX}member`;
  const legacyToken = `${TOKEN_PREFIX}legacy`;

  beforeAll(async () => {
    const account = await prisma.account.create({
      data: { name: 'Notif Routing', email: `account${EMAIL_DOMAIN}` },
    });
    accountId = account.id;
    const owner = await prisma.user.create({
      data: {
        accountId,
        supabaseUserId: 'notif-owner-1',
        email: `owner${EMAIL_DOMAIN}`,
        role: 'owner',
      },
    });
    ownerId = owner.id;
    const member = await prisma.user.create({
      data: {
        accountId,
        supabaseUserId: 'notif-member-1',
        email: `member${EMAIL_DOMAIN}`,
        role: 'member',
        permissionsJson: '[]',
      },
    });
    memberId = member.id;
    await pushService.registerDevice(accountId, { platform: 'ios', token: ownerToken }, ownerId);
    await pushService.registerDevice(accountId, { platform: 'ios', token: memberToken }, memberId);
    // Legacy/demo-era row: no userId — must follow the OWNER's prefs.
    await pushService.registerDevice(accountId, { platform: 'ios', token: legacyToken }, null);
    // Member opts weekly_brief to email-only HERE (not in a sibling it()) so
    // every routing test below holds under `vitest -t` single-test filtering.
    await notificationService.updatePrefs(accountId, memberId, {
      ...DEFAULT_NOTIFICATION_PREFS,
      weekly_brief: { push: false, email: true },
    });
  });

  it('getPrefs/updatePrefs read and write the per-user row', async () => {
    // beforeAll wrote the member's override via updatePrefs; it round-trips
    // and the owner's row is untouched defaults.
    expect(await notificationService.getPrefs(accountId, memberId)).toEqual({
      ...DEFAULT_NOTIFICATION_PREFS,
      weekly_brief: { push: false, email: true },
    });
    expect(await notificationService.getPrefs(accountId, ownerId)).toEqual(
      DEFAULT_NOTIFICATION_PREFS,
    );
  });

  it('pushes to opted-in users only; null-userId devices follow the owner', async () => {
    // Member opted out of weekly_brief push (beforeAll); owner is default on.
    await notificationService.notifyCategory(accountId, 'weekly_brief', {
      push: { title: 'Brief', body: 'ready', deepLink: '/reports/x' },
    });
    const tokens = sentPushes.map((p) => p.deviceToken);
    expect(tokens).toContain(ownerToken);
    expect(tokens).toContain(legacyToken); // owner's prefs govern legacy rows
    expect(tokens).not.toContain(memberToken);
  });

  it('emails opted-in users at their sign-in address; push-only users get none', async () => {
    await notificationService.notifyCategory(accountId, 'weekly_brief', {
      push: { title: 'Brief', body: 'ready' },
      email: { subject: 'Weekly brief', body: 'The brief.' },
    });
    // Member opted into weekly_brief email; owner default is email off.
    expect(sentEmails.map((e) => e.to)).toEqual([`member${EMAIL_DOMAIN}`]);
  });

  it('never throws when the email adapter fails for one recipient', async () => {
    // "fail" in the address makes the mock adapter throw.
    await prisma.user.update({
      where: { id: memberId },
      data: { email: `member.fail${EMAIL_DOMAIN}` },
    });
    await expect(
      notificationService.notifyCategory(accountId, 'weekly_brief', {
        push: { title: 'Brief', body: 'ready' },
        email: { subject: 'Weekly brief', body: 'The brief.' },
      }),
    ).resolves.toBeUndefined();
    expect(sentEmails).toHaveLength(0);
    // Owner + legacy pushes still went out despite the email failure.
    expect(sentPushes.map((p) => p.deviceToken).sort()).toEqual([legacyToken, ownerToken].sort());
    await prisma.user.update({
      where: { id: memberId },
      data: { email: `member${EMAIL_DOMAIN}` },
    });
  });

  it('corrupt per-user stored JSON degrades to defaults', async () => {
    await prisma.user.update({
      where: { id: ownerId },
      data: { notificationPrefsJson: ']broken[' },
    });
    expect(await notificationService.getPrefs(accountId, ownerId)).toEqual(
      DEFAULT_NOTIFICATION_PREFS,
    );
    await prisma.user.update({ where: { id: ownerId }, data: { notificationPrefsJson: '{}' } });
  });

  it('demo mode (no User rows) uses account-level prefs, all devices and Account.email', async () => {
    const account = await prisma.account.create({
      data: {
        name: 'Notif Demo Path',
        email: `demo-path${EMAIL_DOMAIN}`,
        notificationPrefsJson: JSON.stringify({ monthly_review: { push: true, email: true } }),
      },
    });
    const token = `${TOKEN_PREFIX}demo_path`;
    await pushService.registerDevice(account.id, { platform: 'ios', token }, null);

    await notificationService.notifyCategory(account.id, 'monthly_review', {
      push: { title: 'Review', body: 'ready' },
      email: { subject: 'Monthly review', body: 'The review.' },
    });
    expect(sentPushes.some((p) => p.deviceToken === token)).toBe(true);
    expect(sentEmails.map((e) => e.to)).toEqual([`demo-path${EMAIL_DOMAIN}`]);

    // monthly_review defaults are all-off: without the stored override nothing
    // would have been delivered.
    resetMockEmail();
    resetMockPush();
    await prisma.account.update({
      where: { id: account.id },
      data: { notificationPrefsJson: '{}' },
    });
    await notificationService.notifyCategory(account.id, 'monthly_review', {
      push: { title: 'Review', body: 'ready' },
      email: { subject: 'Monthly review', body: 'The review.' },
    });
    expect(sentPushes).toHaveLength(0);
    expect(sentEmails).toHaveLength(0);
  });
});

describe('registerDevice userId stamping', () => {
  it('stamps on create and re-stamps on the upsert update path', async () => {
    const token = `${TOKEN_PREFIX}restamp`;
    const account = await prisma.account.create({
      data: { name: 'Notif Restamp', email: `restamp${EMAIL_DOMAIN}` },
    });
    const user = await prisma.user.create({
      data: {
        accountId: account.id,
        supabaseUserId: 'notif-restamp-1',
        email: `restamp-user${EMAIL_DOMAIN}`,
        role: 'owner',
      },
    });

    await pushService.registerDevice(account.id, { platform: 'ios', token }, null);
    expect(
      (await prisma.pushDevice.findUniqueOrThrow({ where: { token } })).userId,
    ).toBeNull();

    // Relaunch with a signed-in user: the same token self-heals.
    await pushService.registerDevice(account.id, { platform: 'ios', token }, user.id);
    expect((await prisma.pushDevice.findUniqueOrThrow({ where: { token } })).userId).toBe(
      user.id,
    );
  });
});
