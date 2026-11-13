import { hasTestFailures } from './test-result.ts';

import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

// Render builds run in isolation from the running bot. Never inherit runtime
// credentials into tests, and never fall back to DATABASE_URL.
const isolated = process.argv.includes('--isolated') || process.env.RENDER === 'true';
const env = Object.fromEntries(
  ['PATH', 'HOME', 'TMPDIR', 'SystemRoot']
    .filter(key => process.env[key])
    .map(key => [key, process.env[key]]),
);
const files = (await readdir('tests'))
  .filter(file => file.endsWith('.test.ts'))
  .sort()
  .map(file => 'tests/' + file);

async function run(args, extra = {}, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    const suite = args.includes('--test');
    const child = spawn(process.execPath, args, {
      stdio: suite ? ['inherit', 'pipe', 'pipe'] : 'inherit',
      cwd,
      env: { ...env, ...extra, NO_COLOR: '1', FORCE_COLOR: '0' },
    });

    let output = '';
    let timedOut = false;
    let settled = false;

    if (suite) {
      for (const stream of [child.stdout, child.stderr]) {
        stream.on('data', chunk => {
          const text = chunk.toString();
          (stream === child.stdout ? process.stdout : process.stderr).write(chunk);
          // TAP's summary is at the end. Keep a bounded tail for a fallback
          // check in case a runner incorrectly exits with status 0.
          output = (output + text).slice(-65536);
        });
      }
    }

    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 180000);

    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(error);
    });

    child.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      const reportFailed = suite && hasTestFailures(output);
      resolve(timedOut || reportFailed ? 1 : (code ?? 1));
    });
  });
}

if (!isolated) {
  process.exitCode = await run(
    ['--test', '--test-reporter=tap', ...files],
    process.env.MLG_TEST_DATABASE_URL
      ? { MLG_TEST_DATABASE_URL: process.env.MLG_TEST_DATABASE_URL }
      : {},
  );
} else {
  if (process.getuid?.() === 0) {
    throw new Error('Isolated PostgreSQL requires a non-root build runner; no user or permission changes are performed.');
  }

  process.umask(0o077);
  const root = await mkdtemp(join(tmpdir(), 'mlg-integration-'));
  let pg;

  try {
    // Only this reviewed package needs its symlink installer, not all npm scripts.
    const binary = fileURLToPath(
      import.meta.resolve('@embedded-postgres/' + process.platform + '-' + process.arch),
    );
    const hydrate = join(dirname(binary), '../scripts/hydrate-symlinks.js');
    if (await run([hydrate], {}, join(dirname(binary), '..')) !== 0) {
      throw new Error('PostgreSQL binary preparation failed');
    }

    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const password = randomBytes(24).toString('hex');
    pg = new EmbeddedPostgres({
      databaseDir: join(root, 'data'),
      port: 15432,
      user: 'postgres',
      password,
      persistent: false,
      authMethod: 'scram-sha-256',
      createPostgresUser: false,
      postgresFlags: ['-h', '127.0.0.1', '-k', root],
      onLog: () => {},
      onError: () => {},
    });

    await pg.initialise();
    await pg.start();
    console.log('ISOLATED_POSTGRES_READY — temporary local database, no production data');
    process.exitCode = await run(
      ['--test', '--test-reporter=tap', ...files],
      { MLG_TEST_DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:15432/postgres` },
    );
  } finally {
    if (pg) await pg.stop();
    await rm(root, { recursive: true, force: true });
  }
}
