/** Error safe to expose through the loopback integration API. */
export class IntegrationApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'IntegrationApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
