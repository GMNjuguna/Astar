/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    typedRoutes: true,
  },
  images: {
    /*
     * Only the host the landing-page hero actually loads from. The previous
     * entry (images.unsplash.com) was left behind by the hero redesign and
     * granted optimiser access to a third party nothing referenced — an
     * allowlist that accumulates dead hosts is no longer an allowlist.
     *
     * See the HERO_IMAGE comment in app/page.tsx for the hotlinking caveats.
     */
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'upload.wikimedia.org',
      },
    ],
  },
};

export default nextConfig;
