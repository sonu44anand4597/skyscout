import dns from 'node:dns';

// setServers changes resolve* but not the OS getaddrinfo used by socket lookup.
// Recover transient OS lookup errors without changing TLS host verification.
export function createDatabaseLookup({ lookup = dns.lookup, resolve4 = dns.resolve4, now = Date.now } = {}) {
  const cache = new Map();
  return (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    const opts = typeof options === 'number' ? { family: options } : options || {};
    const respond = (addresses) => opts.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family);
    lookup(hostname, opts, (error, address, family) => {
      if (!error) {
        const addresses = opts.all ? address : [{ address, family }];
        cache.set(hostname, { addresses, expiresAt: now() + 5 * 60000 });
        return respond(addresses);
      }
      const saved = cache.get(hostname);
      const compatible = saved?.addresses.filter((item) => !opts.family || item.family === opts.family);
      if (saved?.expiresAt > now() && compatible.length) return respond(compatible);
      if (opts.family === 6) return callback(error);
      resolve4(hostname, (resolveError, ips) => {
        if (resolveError || !ips?.length) return callback(error);
        const addresses = ips.map((ip) => ({ address: ip, family: 4 }));
        cache.set(hostname, { addresses, expiresAt: now() + 5 * 60000 });
        return respond(addresses);
      });
    });
  };
}
