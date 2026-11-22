// A custom header forces a CORS preflight. Browsers cannot add it from a form.
// Validate Origin as well, including for login, to prevent login CSRF.
export function protectMutations(origins) {
  const trusted = new Set(origins);
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (req.get('x-skyscout-request') !== '1' || (origin && !trusted.has(origin))) {
      return res.status(403).json({ success: false, code: 'CSRF_REJECTED', message: 'This request is not permitted. Reload SkyScout and try again.' });
    }
    return next();
  };
}
