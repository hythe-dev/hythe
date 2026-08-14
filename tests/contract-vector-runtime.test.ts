import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteVecClient } from '../src/memory/sqlite-vec-client.js';

const ORIGINAL_CACHE_DIR = process.env.SQLITE_VEC_CACHE_DIR;
const ORIGINAL_REMOTE_MODELS = process.env.SQLITE_VEC_ALLOW_REMOTE_MODELS;
const ORIGINAL_TRANSFORMERS_MODULE = process.env.SQLITE_VEC_TRANSFORMERS_MODULE;
const ORIGINAL_REQUIRE_TRANSFORMERS = process.env.SQLITE_VEC_REQUIRE_TRANSFORMERS;

afterEach(() => {
  if (ORIGINAL_CACHE_DIR === undefined) delete process.env.SQLITE_VEC_CACHE_DIR;
  else process.env.SQLITE_VEC_CACHE_DIR = ORIGINAL_CACHE_DIR;

  if (ORIGINAL_REMOTE_MODELS === undefined) delete process.env.SQLITE_VEC_ALLOW_REMOTE_MODELS;
  else process.env.SQLITE_VEC_ALLOW_REMOTE_MODELS = ORIGINAL_REMOTE_MODELS;

  if (ORIGINAL_TRANSFORMERS_MODULE === undefined) delete process.env.SQLITE_VEC_TRANSFORMERS_MODULE;
  else process.env.SQLITE_VEC_TRANSFORMERS_MODULE = ORIGINAL_TRANSFORMERS_MODULE;

  if (ORIGINAL_REQUIRE_TRANSFORMERS === undefined) delete process.env.SQLITE_VEC_REQUIRE_TRANSFORMERS;
  else process.env.SQLITE_VEC_REQUIRE_TRANSFORMERS = ORIGINAL_REQUIRE_TRANSFORMERS;
});

describe('sqlite-vec transformer runtime contract', () => {
  it('selects the cached q8 model and honors offline/cache settings', async () => {
    process.env.SQLITE_VEC_CACHE_DIR = '/protected/model-cache';
    process.env.SQLITE_VEC_ALLOW_REMOTE_MODELS = 'false';

    const db = new Database(':memory:');
    const client = new SqliteVecClient(db);
    const transformerEnv: Record<string, unknown> = {};
    const pipeline = vi.fn();
    const pipelineFactory = vi.fn(async () => pipeline);

    (client as any).dynamicImportTransformers = vi.fn(async () => ({
      env: transformerEnv,
      pipeline: pipelineFactory,
    }));

    try {
      const resolvedPipeline = await (client as any).getEmbeddingPipeline();

      expect(resolvedPipeline).toBe(pipeline);
      expect(transformerEnv).toMatchObject({
        cacheDir: '/protected/model-cache',
        allowRemoteModels: false,
      });
      expect(pipelineFactory).toHaveBeenCalledOnce();
      expect(pipelineFactory).toHaveBeenCalledWith(
        'feature-extraction',
        'Xenova/all-MiniLM-L6-v2',
        { dtype: 'q8' },
      );
    } finally {
      db.close();
    }
  });

  it('uses a deterministic normalized hash embedding without creating a model cache when the optional runtime is absent', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'hythe-hash-embedding-'));
    const cacheDir = join(tempRoot, 'models');
    process.env.SQLITE_VEC_CACHE_DIR = cacheDir;
    delete process.env.SQLITE_VEC_REQUIRE_TRANSFORMERS;

    const db = new Database(':memory:');
    const client = new SqliteVecClient(db);
    (client as any).dynamicImportTransformers = vi.fn(async () => null);

    try {
      const first = await (client as any).createEmbedding('alpha beta alpha');
      const second = await (client as any).createEmbedding('alpha beta alpha');

      expect(first).toEqual(second);
      expect(first).toHaveLength(384);
      expect(first.every((value: number) => Number.isFinite(value))).toBe(true);
      expect(Math.sqrt(first.reduce((sum: number, value: number) => sum + value * value, 0))).toBeCloseTo(1, 12);
      expect(existsSync(cacheDir)).toBe(false);
    } finally {
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('treats an explicit transformer module as authoritative instead of trying another provider', async () => {
    process.env.SQLITE_VEC_TRANSFORMERS_MODULE = 'file:///opt/hythe-transformers/runtime.js';

    const db = new Database(':memory:');
    const client = new SqliteVecClient(db);
    const importer = vi.fn(async () => {
      throw new Error('missing configured module');
    });
    (client as any).importTransformerModule = importer;

    try {
      await expect((client as any).dynamicImportTransformers()).resolves.toBeNull();
      expect(importer).toHaveBeenCalledOnce();
      expect(importer).toHaveBeenCalledWith('file:///opt/hythe-transformers/runtime.js');
    } finally {
      db.close();
    }
  });

  it('fails closed instead of mixing hash vectors when the Docker transformer lane is required', async () => {
    process.env.SQLITE_VEC_REQUIRE_TRANSFORMERS = 'true';

    const db = new Database(':memory:');
    const client = new SqliteVecClient(db);
    (client as any).getEmbeddingPipeline = vi.fn(async () => async () => {
      throw new Error('required q8 runtime failed');
    });

    try {
      await expect((client as any).createEmbedding('must not hash')).rejects.toThrow('required q8 runtime failed');
    } finally {
      db.close();
    }
  });
});
