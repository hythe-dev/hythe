const moduleSpecifier = process.env.SQLITE_VEC_TRANSFORMERS_MODULE;
const cacheDir = process.env.SQLITE_VEC_CACHE_DIR;
const model = process.env.SQLITE_VEC_MODEL || 'Xenova/all-MiniLM-L6-v2';

if (!moduleSpecifier) {
  throw new Error('SQLITE_VEC_TRANSFORMERS_MODULE is required in the Docker runtime');
}
if (!cacheDir) {
  throw new Error('SQLITE_VEC_CACHE_DIR is required in the Docker runtime');
}

const transformers = await import(moduleSpecifier);
const env = transformers.env || transformers.default?.env;
const pipelineFactory = transformers.pipeline || transformers.default?.pipeline;

if (!env || typeof pipelineFactory !== 'function') {
  throw new Error(`Transformer module ${moduleSpecifier} does not expose env + pipeline()`);
}

env.cacheDir = cacheDir;
env.allowRemoteModels = process.env.SQLITE_VEC_ALLOW_REMOTE_MODELS !== 'false';

const pipeline = await pipelineFactory('feature-extraction', model, { dtype: 'q8' });
const result = await pipeline('hythe runtime preflight', { pooling: 'mean', normalize: true });
const values = result?.data
  ? Array.from(result.data)
  : typeof result?.tolist === 'function'
    ? result.tolist().flat(Infinity)
    : [];
const dimensions = Number.parseInt(process.env.SQLITE_VEC_DIMENSIONS || '384', 10);

if (values.length !== dimensions || values.some((value) => !Number.isFinite(Number(value)))) {
  throw new Error(`q8 embedding preflight returned ${values.length} values; expected ${dimensions} finite values`);
}

console.log(`HYTHE transformer preflight passed (${model}, q8, ${dimensions} dimensions)`);
