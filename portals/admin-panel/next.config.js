/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  images: {
    domains: ['avid-oyster-465.convex.cloud', 'zany-kudu-607.convex.cloud'],
  },
  // F15: global security headers. Applied to every response (including
  // static assets) by Next.js. CSP is tight by default — connect-src is
  // open only to Convex (cloud + site) which is where every backend call
  // goes; frame-ancestors 'none' prevents the admin panel from being
  // framed by any other site.
  //
  // DEV-only: Next.js's hot-module-replacement and React Fast Refresh
  // need 'unsafe-eval' + 'unsafe-inline' to inject and re-evaluate code
  // on the fly. Without those, React never hydrates in dev mode and the
  // page is non-interactive (forms don't submit, buttons don't react).
  // Production builds emit fully-compiled bundles and don't need them.
  async headers() {
    const isDev = process.env.NODE_ENV !== 'production';
    const scriptSrc = isDev
      ? "'self' 'unsafe-eval' 'unsafe-inline'"
      : "'self'";
    const connectExtra = isDev ? " ws://localhost:* http://localhost:*" : "";
    const csp = `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.convex.cloud https://*.convex.site${connectExtra}; img-src 'self' data: https://*.convex.cloud; frame-ancestors 'none'`;
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Content-Security-Policy', value: csp },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
