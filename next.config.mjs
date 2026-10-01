/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [
      // Tavily-compatible top-level /search route alias to /api/search
      {
        source: '/search',
        destination: '/api/search',
      },
      // Tavily-compatible top-level /triggers route alias to /api/triggers
      {
        source: '/triggers',
        destination: '/api/triggers',
      },
      // Tavily-compatible top-level /scrape route alias to /api/scrape
      {
        source: '/scrape',
        destination: '/api/scrape',
      },
    ];
  },
};

export default nextConfig;
