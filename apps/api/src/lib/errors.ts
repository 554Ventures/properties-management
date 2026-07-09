// Error types the error-handler plugin maps onto the shared ApiError shape.

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    /** Structured, client-parseable context; echoed in the error envelope. */
    public readonly detail?: Record<string, string>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class NotFoundError extends HttpError {
  constructor(entityType: string, id?: string) {
    super(404, 'not_found', id ? `${entityType} ${id} not found` : `${entityType} not found`);
    this.name = 'NotFoundError';
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string) {
    super(400, 'bad_request', message);
    this.name = 'BadRequestError';
  }
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, 'conflict', message);
    this.name = 'ConflictError';
  }
}

export class PlaidNotConnectedError extends HttpError {
  constructor() {
    super(409, 'plaid_not_connected', 'Connect a bank account in Settings before importing.');
    this.name = 'PlaidNotConnectedError';
  }
}

export class ImportRateLimitedError extends HttpError {
  constructor(nextAllowedAt: Date) {
    super(429, 'import_rate_limited', 'Bank transactions were already imported recently.', {
      nextAllowedAt: nextAllowedAt.toISOString(),
    });
    this.name = 'ImportRateLimitedError';
  }
}

export class ReceiptScanFailedError extends HttpError {
  constructor() {
    super(502, 'receipt_scan_failed', "Couldn't read the receipt — enter the details manually.");
    this.name = 'ReceiptScanFailedError';
  }
}
