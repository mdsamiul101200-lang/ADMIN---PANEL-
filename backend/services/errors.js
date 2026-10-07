class ValidationError extends Error { constructor(m) { super(m); this.name = 'ValidationError'; } }
class HttpError extends Error { constructor(status, m) { super(m); this.name = 'HttpError'; this.status = status; } }
class ProviderError extends Error {
  constructor(category, publicMessage, { httpStatus, detail } = {}) {
    super(publicMessage);
    this.name = 'ProviderError';
    this.category = category;
    this.publicMessage = publicMessage;
    this.httpStatus = httpStatus;
    this.detail = detail; // technical detail: server logs only, never sent to the browser
  }
}
module.exports = { ValidationError, HttpError, ProviderError };
