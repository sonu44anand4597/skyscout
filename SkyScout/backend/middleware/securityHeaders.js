export default function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  const contentSecurityPolicy = process.env.SERVE_WEB === 'true'
    ? "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; base-uri 'self'; form-action 'self' https://google.com https://*.google.com; frame-ancestors 'none'"
    : "default-src 'none'; frame-ancestors 'none'";
  res.setHeader('Content-Security-Policy', contentSecurityPolicy);
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  if (req.path.startsWith("/api/auth") || req.path.startsWith("/api/tracked-flights")) {
    res.setHeader("Cache-Control", "no-store");
  }
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}
