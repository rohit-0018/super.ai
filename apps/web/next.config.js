/** @type {import('next').NextConfig} */
// Static export: Render serves apps/web/out as a static site.
// All pages are client components + talk to NEXT_PUBLIC_API_BASE, so no SSR is needed.
module.exports = {
  reactStrictMode: true,
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
};
