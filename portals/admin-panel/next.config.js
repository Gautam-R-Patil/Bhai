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
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          {
            key: 'Content-Security-Policy',
            value: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.convex.cloud https://*.convex.site; img-src 'self' data: https://*.convex.cloud; frame-ancestors 'none'",
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
