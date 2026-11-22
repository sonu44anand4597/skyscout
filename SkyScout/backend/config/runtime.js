export function allowedOrigins(env = process.env) {
  const defaults = env.NODE_ENV === 'production' ? '' : 'http://localhost:5173,http://127.0.0.1:5173';
  return (env.CLIENT_ORIGINS || env.CLIENT_ORIGIN || env.RENDER_EXTERNAL_URL || defaults)
    .split(',').map((origin) => origin.trim()).filter(Boolean).map((origin) => {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('CLIENT_ORIGINS must contain exact HTTP origins without paths.');
      return url.origin;
    });
}

export function validateRuntime(env = process.env) {
  const origins = allowedOrigins(env);
  if (env.NODE_ENV === 'production') {
    if (!env.MONGODB_URI) throw new Error('MONGODB_URI is required in production.');
    if ((!env.CLIENT_ORIGIN && !env.CLIENT_ORIGINS && !env.RENDER_EXTERNAL_URL) || !origins.length) throw new Error('Configure the production CLIENT_ORIGINS allowlist.');
    if (origins.some((origin) => !origin.startsWith('https://'))) throw new Error('Production client origins must use HTTPS.');
  }
  if (env.SESSION_SAME_SITE && !['lax', 'strict', 'none'].includes(env.SESSION_SAME_SITE.toLowerCase())) throw new Error('SESSION_SAME_SITE must be lax, strict or none.');
  if (env.SESSION_SAME_SITE?.toLowerCase() === 'none' && env.NODE_ENV !== 'production') throw new Error('SameSite=None requires production Secure cookies.');
  if (env.TRUST_PROXY && !/^\d+$/.test(env.TRUST_PROXY)) throw new Error('TRUST_PROXY must be the exact number of trusted proxy hops.');
  if (env.PORT && (!/^\d+$/.test(env.PORT) || Number(env.PORT) < 1 || Number(env.PORT) > 65535)) throw new Error('PORT must be a TCP port between 1 and 65535.');
  return { origins };
}
