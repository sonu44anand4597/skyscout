const developmentApiOrigin = typeof window === "undefined"
  ? "http://127.0.0.1:5000"
  : `http://${window.location.hostname.includes(":") ? `[${window.location.hostname}]` : window.location.hostname}:5000`;
const API_BASE = import.meta.env?.VITE_API_URL || (import.meta.env?.PROD ? '/api' : `${developmentApiOrigin}/api`);

export async function apiRequest(path, { method = "GET", body, signal, timeoutMs = 25000 } = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: "include",
      headers: { ...(!['GET', 'HEAD'].includes(method.toUpperCase()) ? { 'X-SkyScout-Request': '1' } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error.name === "TimeoutError") throw new Error("The request timed out. Please try again.", { cause: error });
    throw new Error("Unable to reach SkyScout. Check that the API is running.", { cause: error });
  }
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    const error = new Error(data.message || "The request could not be completed.");
    error.status = response.status;
    error.code = data.code;
    error.requestId = response.headers.get('x-request-id');
    throw error;
  }
  return data;
}

export async function getServiceHealth() {
  const apiOrigin = API_BASE.replace(/\/api\/?$/, "");
  const response = await fetch(`${apiOrigin}/health`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("Health status unavailable.");
  return response.json();
}
