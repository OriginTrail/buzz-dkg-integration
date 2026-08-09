/** Error safe to expose through the loopback integration API. */
export class IntegrationApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'IntegrationApiError';
    this.status = status;
    this.code = code;
  }
}
