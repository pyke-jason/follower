import type { NextConfig } from 'next';
import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(__dirname, '../.env') });

const nextConfig: NextConfig = {
  transpilePackages: ['../src'],
  serverExternalPackages: ['@libsql/client', 'better-sqlite3'],
};

export default nextConfig;
