// Domain error type. src/domain imports nothing outside src/domain, so it defines its own AppError.
// Shape (status, code, message, details) matches the HTTP error envelope; the HTTP layer maps it by duck typing
// (`err.name === 'AppError'`) or by re-exporting this class. `message` is fixed English text per code and never
// echoes caller input; `details` holds only ids, codes and server-derived values.

export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
