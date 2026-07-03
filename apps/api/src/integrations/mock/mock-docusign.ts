// Mock Docusign: envelope ids + a simple sent → viewed → signed progression.
import type { EsignStatus } from '@hearth/shared';
import type { DocusignAdapter } from '../types';

let envelopeCounter = 0;

export const mockDocusign: DocusignAdapter = {
  async sendEnvelope(leaseId, _signerName) {
    envelopeCounter += 1;
    return { envelopeId: `env_mock_${envelopeCounter}_${leaseId.slice(-6)}`, status: 'sent' };
  },

  advanceStatus(current: EsignStatus | null): EsignStatus {
    if (current === 'sent') return 'viewed';
    if (current === 'viewed') return 'signed';
    if (current === 'signed') return 'signed';
    return 'sent';
  },
};
