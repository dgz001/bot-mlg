import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMigrationFailure,
  validateMigrationConfig,
} from '../scripts/migrate.ts';

const validPassword = 'p'.repeat(40);
const validUrl = 'postgresql://postgres.project:db-password@db.example.com:5432/postgres';

test('pré-validação identifica variáveis ausentes pelo nome, sem expor valores', () => {
  assert.throws(
    () => validateMigrationConfig({}),
    /DATABASE_URL, APP_DATABASE_PASSWORD/,
  );
});

test('pré-validação rejeita protocolo de banco inesperado', () => {
  assert.throws(
    () => validateMigrationConfig({
      DATABASE_URL: 'mysql://user:password@example.com/db',
      APP_DATABASE_PASSWORD: validPassword,
    }),
    /postgres ou postgresql/,
  );
});

test('pré-validação rejeita senha de aplicação curta', () => {
  assert.throws(
    () => validateMigrationConfig({
      DATABASE_URL: validUrl,
      APP_DATABASE_PASSWORD: 'short',
    }),
    /at least 32 characters/,
  );
});

test('pré-validação aceita URL PostgreSQL e senha de aplicação fortes', () => {
  const config = validateMigrationConfig({
    DATABASE_URL: validUrl,
    APP_DATABASE_PASSWORD: validPassword,
  });
  assert.equal(config.databaseUrl, validUrl);
  assert.equal(config.appPassword, validPassword);
});

test('diagnóstico registra etapa e SQLSTATE sem vazar URL ou senha', () => {
  const env = {
    DATABASE_URL: validUrl,
    APP_DATABASE_PASSWORD: validPassword,
  };
  const error = Object.assign(
    new Error(`password=${validPassword}; connection failed for ${validUrl}`),
    { code: '28P01', severity: 'ERROR' },
  );

  const diagnostic = formatMigrationFailure('database_connect', error, env);
  assert.equal(diagnostic.event, 'MIGRATIONS_FAILED');
  assert.equal(diagnostic.stage, 'database_connect');
  assert.equal(diagnostic.code, '28P01');
  assert.equal(diagnostic.severity, 'ERROR');
  assert.doesNotMatch(JSON.stringify(diagnostic), /db-password|postgres\.project|p{32}/);
  assert.match(diagnostic.message, /REDACTED/);
});
