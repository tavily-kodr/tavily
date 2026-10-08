/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@tavily/config', '@tavily/errors', '@tavily/logger', '@tavily/searching'],
  async rewrites() {
    return [
      {
        source: '/search',
        destination: '/api/search',
      },
    ];
  },
};

export default nextConfig;
