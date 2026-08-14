#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'hythe-packed-consumer-'));
const consumer = join(work, 'consumer');

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status})\n${result.stdout || ''}${result.stderr || ''}`
    );
  }
  return result;
};

try {
  const packed = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work]);
  const packReport = JSON.parse(packed.stdout);
  const tarballName = packReport?.[0]?.filename;
  if (!tarballName) throw new Error(`npm pack did not report a tarball name: ${packed.stdout}`);
  const tarball = join(work, tarballName);
  const packedPaths = Array.isArray(packReport?.[0]?.files)
    ? packReport[0].files.map((entry) => String(entry.path || ''))
    : [];
  if (packedPaths.some((path) => /(^|\/)node_modules(\/|$)/.test(path))) {
    throw new Error('npm tarball contains a node_modules tree');
  }
  for (const requiredDockerPath of [
    'docker/transformers-runtime/package.json',
    'docker/transformers-runtime/package-lock.json',
    'docker/verify-transformer-runtime.mjs',
  ]) {
    if (!packedPaths.includes(requiredDockerPath)) {
      throw new Error(`npm tarball omits Docker runtime artifact: ${requiredDockerPath}`);
    }
  }
  if (Number(packReport?.[0]?.size) > 2 * 1024 * 1024) {
    throw new Error(`npm tarball unexpectedly exceeds 2 MiB: ${packReport[0].size} bytes`);
  }

  mkdirSync(consumer);
  writeFileSync(
    join(consumer, 'package.json'),
    `${JSON.stringify({
      name: 'hythe-packed-consumer-proof',
      version: '1.0.0',
      private: true,
      dependencies: { '@hythe/mcp': `file:${tarball}` },
    }, null, 2)}\n`
  );

  run('npm', ['install', '--no-audit', '--no-fund'], { cwd: consumer });

  const installedPackage = JSON.parse(
    readFileSync(join(consumer, 'node_modules/@hythe/mcp/package.json'), 'utf8')
  );
  if (installedPackage.dependencies?.['@xenova/transformers'] !== undefined) {
    throw new Error('packed consumer installed @xenova/transformers as a production dependency');
  }
  if (installedPackage.peerDependenciesMeta?.['@xenova/transformers']?.optional !== true) {
    throw new Error('packed consumer transformer peer is not optional');
  }
  for (const transformerPath of [
    'node_modules/@xenova/transformers',
    'node_modules/@huggingface/transformers',
    'node_modules/@hythe/mcp/node_modules/@xenova/transformers',
    'node_modules/@hythe/mcp/node_modules/@huggingface/transformers',
  ]) {
    if (existsSync(join(consumer, transformerPath))) {
      throw new Error(`packed consumer unexpectedly contains transformer runtime: ${transformerPath}`);
    }
  }

  const audit = run('npm', ['audit', '--omit=dev', '--json'], { cwd: consumer, allowFailure: true });
  const auditReport = JSON.parse(audit.stdout || '{}');
  const vulnerabilityCount = auditReport?.metadata?.vulnerabilities?.total;
  if (audit.status !== 0 || vulnerabilityCount !== 0) {
    throw new Error(`packed consumer production audit failed (${vulnerabilityCount ?? 'unknown'} findings)\n${audit.stdout}${audit.stderr}`);
  }

  const cli = run(join(consumer, 'node_modules/.bin/hythe-mcp'), ['--help'], { cwd: consumer });
  if (!cli.stdout.includes('@hythe/mcp — HYTHE stdio bridge')) {
    throw new Error('packed consumer CLI help contract drift');
  }

  const migration = join(consumer, 'node_modules/@hythe/mcp/dist/migrations/007-private-message-residue.mjs');
  const emptyDatabase = join(work, 'empty.db');
  const initializeDatabasePath = join(consumer, 'initialize-database.mjs');
  writeFileSync(initializeDatabasePath, `
import { MemoryManager } from '@hythe/mcp/dist/unified-server/memory/index.js';
process.env.ENABLE_ADVANCED_MEMORY = 'false';
const manager = new MemoryManager(${JSON.stringify(emptyDatabase)});
manager.close();
`);
  run(process.execPath, [initializeDatabasePath], { cwd: consumer });
  const migrationSmoke = run(process.execPath, [migration, emptyDatabase], { cwd: consumer });
  if (!/"mode"\s*:\s*"dry-run"/i.test(`${migrationSmoke.stdout}\n${migrationSmoke.stderr}`)) {
    throw new Error('packed consumer migration did not run in dry-run mode');
  }

  const vectorSmokePath = join(consumer, 'vector-smoke.mjs');
  const cacheDir = join(work, 'unexpected-model-cache');
  writeFileSync(vectorSmokePath, `
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { SqliteVecClient } from '@hythe/mcp/dist/memory/sqlite-vec-client.js';
process.env.SQLITE_VEC_CACHE_DIR = ${JSON.stringify(cacheDir)};
delete process.env.SQLITE_VEC_REQUIRE_TRANSFORMERS;
const db = new Database(':memory:');
try {
  const client = new SqliteVecClient(db);
  const first = await client.createEmbedding('alpha beta alpha');
  const second = await client.createEmbedding('alpha beta alpha');
  const norm = Math.sqrt(first.reduce((sum, value) => sum + value * value, 0));
  if (first.length !== 384 || JSON.stringify(first) !== JSON.stringify(second)) process.exit(2);
  if (!first.every(Number.isFinite) || Math.abs(norm - 1) > 1e-12) process.exit(3);
  if (existsSync(process.env.SQLITE_VEC_CACHE_DIR)) process.exit(4);
  console.log('deterministic hash fallback: 384 finite normalized values; no cache created');
} finally {
  db.close();
}
`);
  const vectorSmoke = run(process.execPath, [vectorSmokePath], { cwd: consumer });
  if (!vectorSmoke.stdout.includes('deterministic hash fallback')) {
    throw new Error('packed consumer hash-fallback smoke contract drift');
  }

  process.stdout.write('Packed HYTHE consumer verification passed: audit 0, CLI + migration + deterministic hash fallback.\n');
} finally {
  rmSync(work, { recursive: true, force: true });
}
