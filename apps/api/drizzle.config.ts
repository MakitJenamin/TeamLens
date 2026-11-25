import { defineConfig } from 'drizzle-kit';
import { loadEnvFile } from './src/config/env.js';

loadEnvFile();

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      'postgres://teamlens:teamlens@localhost:5433/teamlens',
  },
  strict: true,
  verbose: true,
});
