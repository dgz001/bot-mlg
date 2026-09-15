import { spawnSync } from 'node:child_process';
if (!process.env.MLG_TEST_DATABASE_URL) {
  console.error('Integration tests require a disposable PostgreSQL server via MLG_TEST_DATABASE_URL. Tests were not run.');
  process.exit(1);
}
const result = spawnSync(process.execPath,['--test','tests/postgres.test.ts'],{stdio:'inherit'});
process.exit(result.status ?? 1);
