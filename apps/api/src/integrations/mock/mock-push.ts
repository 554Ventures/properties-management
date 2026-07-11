// Mock push: records sends in-memory for test assertions (mirrors mock-email).
// Tokens containing "unregistered" simulate an APNs 410 so tests can exercise
// the delete-on-unregistered path without a real APNs round trip.
import type { PushMessage, PushProvider, PushSendResult } from '../types';

export interface SentPush {
  deviceToken: string;
  message: PushMessage;
}

export const sentPushes: SentPush[] = [];

export function resetMockPush(): void {
  sentPushes.length = 0;
}

export const mockPush: PushProvider = {
  async send(deviceToken, message): Promise<PushSendResult> {
    if (deviceToken.includes('unregistered')) {
      return { ok: false, unregistered: true, reason: 'Unregistered' };
    }
    sentPushes.push({ deviceToken, message });
    // eslint-disable-next-line no-console
    console.log(`[mock-push] → ${deviceToken.slice(0, 12)}…: ${message.title}`);
    return { ok: true };
  },
};
