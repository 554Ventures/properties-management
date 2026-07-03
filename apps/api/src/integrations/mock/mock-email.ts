// Mock email: logs to the console, records nothing external.
import type { EmailAdapter } from '../types';

let messageCounter = 0;

export const mockEmail: EmailAdapter = {
  async send({ to, subject }) {
    messageCounter += 1;
    const messageId = `email_mock_${messageCounter}`;
    // eslint-disable-next-line no-console
    console.log(`[mock-email] ${messageId} → ${to}: ${subject}`);
    return { messageId };
  },
};
