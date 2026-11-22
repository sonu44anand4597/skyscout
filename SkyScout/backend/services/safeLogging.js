// Provider/driver error messages can include request URLs, credentials or bodies.
// Operational logs retain bounded classifications and HTTP status only.
export function serviceErrorDetails(event, error) {
  const categories = new Set(['Error', 'TypeError', 'RangeError', 'AxiosError', 'AbortError', 'TimeoutError', 'MongoServerError', 'MongoNetworkError', 'MongoServerSelectionError', 'MongooseError', 'ValidationError', 'CastError']);
  const providerCodes = new Set(['invalid_key', 'invalid_query', 'not_configured', 'invalid_response', 'quota_exceeded', 'rate_limited', 'concurrency_limited', 'timeout', 'provider_unavailable']);
  const code = typeof error?.code === 'string' && /^E[A-Z_]{2,40}$/.test(error.code) ? error.code
    : Number.isInteger(error?.code) && error.code >= 0 && error.code < 1_000_000 ? error.code : undefined;
  const status = Number(error?.providerStatus || error?.response?.status);
  return {
    event,
    category: categories.has(error?.name) ? error.name : 'service_error',
    ...(code !== undefined ? { code } : {}),
    ...(providerCodes.has(error?.providerCode) ? { providerCode: error.providerCode } : {}),
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {}),
  };
}

export function logServiceError(event, error) {
  console.error(JSON.stringify(serviceErrorDetails(event, error)));
}
