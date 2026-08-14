#!/usr/bin/env node
/** Fail closed when a public HYTHE source tree drifts from its release identity. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const agentKitContract = {
  name: 'hythe',
  source: './clients/agent-kit/claude-code/plugin',
  version: '0.1.1',
};
const privateResidueMigrationContract = {
  source: 'src/migrations/007-private-message-residue.mjs',
  packed: 'dist/migrations/007-private-message-residue.mjs',
  documentation: 'docs/PRIVATE-MESSAGE-RESIDUE-MIGRATION.md',
  command: 'node dist/migrations/007-private-message-residue.mjs',
};
const transformerRuntimeContract = {
  packagePath: 'docker/transformers-runtime/package.json',
  lockPath: 'docker/transformers-runtime/package-lock.json',
  npmIgnorePath: 'docker/transformers-runtime/.npmignore',
  preflightPath: 'docker/verify-transformer-runtime.mjs',
  packageName: '@hythe/transformers-runtime',
  dependency: '@xenova/transformers',
  dependencyVersion: '2.17.2',
  moduleSpecifier: 'file:///opt/hythe-transformers/node_modules/@xenova/transformers/src/transformers.js',
  overrides: { protobufjs: '7.6.5', sharp: '0.35.3' },
};

export const verifyReleaseTree = (root = process.cwd()) => {
  const read = (path) => readFileSync(resolve(root, path), 'utf8');
  const readJson = (path) => JSON.parse(read(path));
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  const server = readJson('server.json');
  const marketplace = readJson('.claude-plugin/marketplace.json');
  const transformerRuntime = readJson(transformerRuntimeContract.packagePath);
  const transformerLock = readJson(transformerRuntimeContract.lockPath);
  const transformerNpmIgnore = read(transformerRuntimeContract.npmIgnorePath);
  const dockerfile = read('docker/Dockerfile');
  const transformerPreflight = read(transformerRuntimeContract.preflightPath);
  const vectorClient = read('src/memory/sqlite-vec-client.ts');
  const envExample = read('.env.example');
  const expectedPackageVersion = pkg.version;
  const failures = [];

  if (pkg.name !== '@hythe/mcp') failures.push(`package name: ${pkg.name}`);
  if (typeof expectedPackageVersion !== 'string' || expectedPackageVersion.length === 0) failures.push('package version missing');
  if (pkg.mcpName !== 'dev.hythe/hythe') failures.push(`mcpName: ${pkg.mcpName}`);
  if (pkg.private === true) failures.push('package remains private:true');
  if (JSON.stringify(pkg.bin) !== JSON.stringify({ 'hythe-mcp': 'bin/engram-mcp.cjs' })) failures.push('bin map drift');
  const packedFiles = Array.isArray(pkg.files) ? pkg.files : [];
  for (const requiredPackedPath of ['bin/', 'dist/', 'docker/', 'docs/', 'mcp-stdio-http-bridge.cjs']) {
    if (!packedFiles.includes(requiredPackedPath)) {
      failures.push(`npm package files missing: ${requiredPackedPath}`);
    }
  }
  if (pkg.scripts?.prepack !== 'npm run build && node scripts/verify-hythe-release-tree.mjs') {
    failures.push('prepack build/release verification drift');
  }
  if (pkg.scripts?.['migrate:private-message-residue'] !== privateResidueMigrationContract.command) {
    failures.push('private-message residue migration command does not use packed dist artifact');
  }
  for (const [label, path] of [
    ['source', privateResidueMigrationContract.source],
    ['packed', privateResidueMigrationContract.packed],
    ['documentation', privateResidueMigrationContract.documentation],
  ]) {
    if (!existsSync(resolve(root, path))) {
      failures.push(`private-message residue migration ${label} artifact missing: ${path}`);
    }
  }
  if (existsSync(resolve(root, privateResidueMigrationContract.documentation))) {
    const migrationDocumentation = read(privateResidueMigrationContract.documentation);
    if (!migrationDocumentation.includes(privateResidueMigrationContract.command)) {
      failures.push('private-message residue migration documentation omits packed dist command');
    }
    if (migrationDocumentation.includes('node src/migrations/007-private-message-residue.mjs')) {
      failures.push('private-message residue migration documentation exposes unpacked source command');
    }
  }
  if (lock.name !== pkg.name) failures.push('lockfile name != package name');
  if (lock.version !== expectedPackageVersion) failures.push('lockfile version != package version');
  if (lock.packages?.['']?.name !== pkg.name) failures.push('lockfile root package name != package name');
  if (lock.packages?.['']?.version !== expectedPackageVersion) failures.push('lockfile root package version != package version');
  if (pkg.dependencies?.[transformerRuntimeContract.dependency] !== undefined) {
    failures.push('published package must not install the transformer runtime as a production dependency');
  }
  if (pkg.devDependencies?.[transformerRuntimeContract.dependency] !== transformerRuntimeContract.dependencyVersion) {
    failures.push('source-tree transformer dev dependency drift');
  }
  if (pkg.peerDependencies?.[transformerRuntimeContract.dependency] !== transformerRuntimeContract.dependencyVersion) {
    failures.push('published optional transformer peer version drift');
  }
  if (pkg.peerDependenciesMeta?.[transformerRuntimeContract.dependency]?.optional !== true) {
    failures.push('published transformer peer must remain optional');
  }
  if (JSON.stringify(pkg.overrides) !== JSON.stringify(transformerRuntimeContract.overrides)) {
    failures.push('source-tree transformer security overrides drift');
  }
  const lockRoot = lock.packages?.[''] || {};
  if (lockRoot.dependencies?.[transformerRuntimeContract.dependency] !== undefined) {
    failures.push('lockfile publishes transformer as a production dependency');
  }
  if (lockRoot.devDependencies?.[transformerRuntimeContract.dependency] !== transformerRuntimeContract.dependencyVersion) {
    failures.push('lockfile transformer dev dependency drift');
  }
  if (lockRoot.peerDependenciesMeta?.[transformerRuntimeContract.dependency]?.optional !== true) {
    failures.push('lockfile transformer peer must remain optional');
  }

  if (transformerRuntime.name !== transformerRuntimeContract.packageName) failures.push('Docker transformer runtime package name drift');
  if (transformerRuntime.version !== expectedPackageVersion) failures.push('Docker transformer runtime version != package version');
  if (transformerRuntime.private !== true) failures.push('Docker transformer runtime must remain private');
  if (transformerRuntime.dependencies?.[transformerRuntimeContract.dependency] !== transformerRuntimeContract.dependencyVersion) {
    failures.push('Docker transformer runtime dependency drift');
  }
  if (JSON.stringify(transformerRuntime.overrides) !== JSON.stringify(transformerRuntimeContract.overrides)) {
    failures.push('Docker transformer runtime security overrides drift');
  }
  if (transformerLock.name !== transformerRuntimeContract.packageName) failures.push('Docker transformer lockfile name drift');
  if (transformerLock.version !== expectedPackageVersion) failures.push('Docker transformer lockfile version != package version');
  const transformerLockRoot = transformerLock.packages?.[''] || {};
  if (transformerLockRoot.dependencies?.[transformerRuntimeContract.dependency] !== transformerRuntimeContract.dependencyVersion) {
    failures.push('Docker transformer lockfile dependency drift');
  }
  if (transformerLock.packages?.['node_modules/protobufjs']?.version !== transformerRuntimeContract.overrides.protobufjs) {
    failures.push('Docker transformer lockfile protobufjs override missing');
  }
  if (transformerLock.packages?.['node_modules/sharp']?.version !== transformerRuntimeContract.overrides.sharp) {
    failures.push('Docker transformer lockfile sharp override missing');
  }
  if (!transformerNpmIgnore.split(/\r?\n/).some((line) => line.trim() === 'node_modules/')) {
    failures.push('Docker transformer runtime npm package exclusion drift');
  }
  for (const requiredDockerFragment of [
    'COPY docker/transformers-runtime/package.json docker/transformers-runtime/package-lock.json ./',
    'npm audit --omit=dev --audit-level=high',
    `SQLITE_VEC_TRANSFORMERS_MODULE=${transformerRuntimeContract.moduleSpecifier}`,
    'SQLITE_VEC_REQUIRE_TRANSFORMERS=true',
    'node docker/verify-transformer-runtime.mjs && exec node dist/unified-neural-mcp-server.js',
  ]) {
    if (!dockerfile.includes(requiredDockerFragment)) {
      failures.push(`Docker transformer runtime contract missing: ${requiredDockerFragment}`);
    }
  }
  if (!transformerPreflight.includes("{ dtype: 'q8' }") || !transformerPreflight.includes('values.length !== dimensions')) {
    failures.push('Docker transformer q8/dimension preflight drift');
  }
  if (!vectorClient.includes('SQLITE_VEC_TRANSFORMERS_MODULE') || !vectorClient.includes('SQLITE_VEC_REQUIRE_TRANSFORMERS')) {
    failures.push('vector client explicit/required transformer contract drift');
  }
  if (server.name !== pkg.mcpName) failures.push('server name != package mcpName');
  if (server.version !== expectedPackageVersion) failures.push('server version != package version');
  if (!Array.isArray(server.packages) || server.packages.length !== 1) failures.push('Registry package entry count drift');
  const registryPackage = server.packages?.[0];
  if (registryPackage?.registryType !== 'npm') failures.push('Registry package type drift');
  if (registryPackage?.identifier !== pkg.name) failures.push('Registry package identifier != package name');
  if (registryPackage?.version !== expectedPackageVersion) failures.push('Registry package version != package version');
  const registryEnvironment = Array.isArray(registryPackage?.environmentVariables)
    ? registryPackage.environmentVariables
    : [];
  const registryIdentityVariables = registryEnvironment
    .filter((entry) => entry?.name === 'HYTHE_AGENT_ID');
  if (registryIdentityVariables.length !== 1) {
    failures.push('Registry HYTHE_AGENT_ID entry count drift');
  } else {
    const identityVariable = registryIdentityVariables[0];
    if (identityVariable.isRequired !== true) failures.push('Registry HYTHE_AGENT_ID must be required');
    if (identityVariable.format !== 'string') failures.push('Registry HYTHE_AGENT_ID format drift');
    if (identityVariable.isSecret !== false) failures.push('Registry HYTHE_AGENT_ID secrecy flag drift');
  }
  if (Object.keys(server).some((key) => key.startsWith('x-hythe-p1'))) failures.push('P1 Registry marker present');
  const agentKitEntries = Array.isArray(marketplace.plugins)
    ? marketplace.plugins.filter((plugin) => plugin?.source === agentKitContract.source)
    : [];
  if (agentKitEntries.length !== 1) failures.push('Claude marketplace agent-kit asset entry count drift');
  const agentKit = agentKitEntries[0];
  if (agentKit?.name !== agentKitContract.name) failures.push('Claude marketplace agent-kit asset name drift');
  if (agentKit?.version !== agentKitContract.version) {
    failures.push(`Claude marketplace agent-kit asset version: ${agentKit?.version ?? 'missing'} (expected ${agentKitContract.version})`);
  }
  const agentKitRoot = agentKitContract.source.replace(/^\.\//, '');
  const identityResolverPath = `${agentKitRoot}/scripts/resolve-agent-id.sh`;
  if (!existsSync(resolve(root, identityResolverPath))) {
    failures.push('Claude marketplace identity resolver asset missing');
  }
  for (const hook of ['session-start.sh', 'post-compaction.sh']) {
    const hookPath = `${agentKitRoot}/scripts/${hook}`;
    if (!existsSync(resolve(root, hookPath))) {
      failures.push(`Claude marketplace hook asset missing: ${hook}`);
    } else if (!read(hookPath).includes('source "$SCRIPT_DIR/resolve-agent-id.sh"')) {
      failures.push(`Claude marketplace hook does not load identity resolver: ${hook}`);
    }
  }
  const publicInitExamples = envExample.split(/\r?\n/).filter((line) => /\bnpx\s+-y\s+@hythe\/mcp\s+init\b/.test(line));
  if (publicInitExamples.length === 0) failures.push('.env.example public init example missing');
  if (publicInitExamples.some((line) => !/--agent-id(?:\s|=)/.test(line))) {
    failures.push('.env.example contains identity-less public init command');
  }
  if (!envExample.includes('HYTHE_AGENT_ID')) {
    failures.push('.env.example does not explain the per-client HYTHE_AGENT_ID requirement');
  }
  if (envExample.split(/\r?\n/).some((line) => /^\s*HYTHE_AGENT_ID\s*=/.test(line))) {
    failures.push('.env.example must not assign a shared server-wide agent identity');
  }
  const readme = read('README.md');
  if (!readme.startsWith('# HYTHE\n')) failures.push('README identity drift');
  if (!readme.includes(`\`${expectedPackageVersion}\` release candidate`)) {
    failures.push('README release-candidate version drift');
  }

  return { expectedPackageVersion, failures };
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { expectedPackageVersion, failures } = verifyReleaseTree();
  if (failures.length) {
    process.stderr.write(`HYTHE release-tree verification failed:\n- ${failures.join('\n- ')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`HYTHE ${expectedPackageVersion} release-tree verification passed; no publish action performed.\n`);
  }
}
