// Mock email: logs to the console and records sends in-memory for test
// assertions (mirrors mock-push). Addresses containing "fail" simulate a
// provider outage (send throws) so tests can exercise callers' never-throw
// fire-and-forget paths without a real provider round trip.
import type { EmailAdapter, EmailMessage } from '../types';

export const sentEmails: EmailMessage[] = [];

export function resetMockEmail(): void {
  sentEmails.length = 0;
}

let messageCounter = 0;

export const mockEmail: EmailAdapter = {
  async send(message) {
    if (message.to.includes('fail')) {
      throw new Error('[mock-email] simulated send failure');
    }
    messageCounter += 1;
    const messageId = `email_mock_${messageCounter}`;
    sentEmails.push(message);
    // eslint-disable-next-line no-console
    console.log(`[mock-email] ${messageId} → ${message.to}: ${message.subject}`);
    return { messageId };
  },
};
