import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['../src'],
  serverExternalPackages: ['@libsql/client', 'better-sqlite3'],
};

export default nextConfig;
