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
const privateResidueAdjudicationContract = {
  source: 'src/migrations/private-message-residue-adjudication.mjs',
  packed: 'dist/migrations/private-message-residue-adjudication.mjs',
  documentation: 'docs/PRIVATE-MESSAGE-RESIDUE-ADJUDICATION.md',
  command: 'node dist/migrations/private-message-residue-adjudication.mjs',
  script: 'adjudicate:private-message-residue',
};
const sqliteSanitationContract = {
  source: 'src/migrations/vacuum-sanitized-database.mjs',
  packed: 'dist/migrations/vacuum-sanitized-database.mjs',
  documentation: 'docs/SQLITE-PHYSICAL-SANITATION.md',
  command: 'node dist/migrations/vacuum-sanitized-database.mjs',
  script: 'sanitize:sqlite',
};
const agentCredentialOperatorContract = {
  bin: 'hythe-agent-auth',
  packed: 'dist/agent-auth/operator.js',
  source: 'src/agent-auth/operator.ts',
  documentation: 'docs/AGENT-CREDENTIAL-OPERATOR.md',
  command: 'node dist/agent-auth/operator.js',
};
const agentPrincipalMigrationContract = {
  source: 'src/migrations/008-agent-principals.mjs',
  packed: 'dist/migrations/008-agent-principals.mjs',
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
  const exactPackageSpec = `@hythe/mcp@${expectedPackageVersion}`;
  const failures = [];

  if (pkg.name !== '@hythe/mcp') failures.push(`package name: ${pkg.name}`);
  if (typeof expectedPackageVersion !== 'string' || expectedPackageVersion.length === 0) failures.push('package version missing');
  if (pkg.mcpName !== 'dev.hythe/hythe') failures.push(`mcpName: ${pkg.mcpName}`);
  if (pkg.private === true) failures.push('package remains private:true');
  if (JSON.stringify(pkg.bin) !== JSON.stringify({
    'hythe-mcp': 'bin/engram-mcp.cjs',
    [agentCredentialOperatorContract.bin]: agentCredentialOperatorContract.packed,
  })) failures.push('bin map drift');
  const packedFiles = Array.isArray(pkg.files) ? pkg.files : [];
  for (const requiredPackedPath of [
    'bin/',
    'dist/',
    'docker/',
    'docs/',
    'mcp-stdio-http-bridge.cjs',
    'CHANGELOG.md',
    'SECURITY.md',
  ]) {
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
  for (const [label, contract] of [
    ['private-message residue adjudication', privateResidueAdjudicationContract],
    ['SQLite sanitation', sqliteSanitationContract],
  ]) {
    if (pkg.scripts?.[contract.script] !== contract.command) {
      failures.push(`${label} command does not use packed dist artifact`);
    }
    for (const [artifactLabel, path] of [
      ['source', contract.source],
      ['packed', contract.packed],
      ['documentation', contract.documentation],
    ]) {
      if (!existsSync(resolve(root, path))) failures.push(`${label} ${artifactLabel} artifact missing: ${path}`);
    }
    if (existsSync(resolve(root, contract.documentation))) {
      const documentation = read(contract.documentation);
      if (!documentation.includes(contract.command)) {
        failures.push(`${label} documentation omits packed dist command`);
      }
      if (documentation.includes(`node ${contract.source}`)) {
        failures.push(`${label} documentation exposes unpacked source command`);
      }
    }
  }
  if (pkg.scripts?.['agent-auth:operator'] !== agentCredentialOperatorContract.command) {
    failures.push('agent credential operator command does not use packed dist artifact');
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
  for (const [label, path] of [
    ['source', agentPrincipalMigrationContract.source],
    ['packed', agentPrincipalMigrationContract.packed],
  ]) {
    if (!existsSync(resolve(root, path))) {
      failures.push(`agent principal migration ${label} artifact missing: ${path}`);
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
  for (const [label, path] of [
    ['source', agentCredentialOperatorContract.source],
    ['packed', agentCredentialOperatorContract.packed],
    ['documentation', agentCredentialOperatorContract.documentation],
  ]) {
    if (!existsSync(resolve(root, path))) {
      failures.push(`agent credential operator ${label} artifact missing: ${path}`);
    }
  }
  if (existsSync(resolve(root, agentCredentialOperatorContract.documentation))) {
    const operatorDocumentation = read(agentCredentialOperatorContract.documentation);
    if (!operatorDocumentation.includes('hythe-agent-auth issue')) {
      failures.push('agent credential operator documentation omits installed binary invocation');
    }
    if (!operatorDocumentation.includes('BEGIN EXCLUSIVE')) {
      failures.push('agent credential operator documentation omits offline exclusive-lock contract');
    }
    if (!operatorDocumentation.includes('mode `0600`')) {
      failures.push('agent credential operator documentation omits secret-file permissions contract');
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
  if (JSON.stringify(lockRoot.bin) !== JSON.stringify({
    'hythe-agent-auth': agentCredentialOperatorContract.packed,
    'hythe-mcp': 'bin/engram-mcp.cjs',
  })) {
    failures.push('lockfile root bin map drift');
  }
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
  for (const contract of [
    { name: 'HYTHE_AGENT_ID', required: true },
    { name: 'HYTHE_AGENT_KEY_FILE', required: false },
    { name: 'HYTHE_AGENT_AUTH_MODE', required: false },
  ]) {
    const matches = registryEnvironment.filter((entry) => entry?.name === contract.name);
    if (matches.length !== 1) {
      failures.push(`Registry ${contract.name} entry count drift`);
      continue;
    }
    const variable = matches[0];
    if (variable.isRequired !== contract.required) {
      failures.push(`Registry ${contract.name} required flag drift`);
    }
    if (variable.format !== 'string') failures.push(`Registry ${contract.name} format drift`);
    if (variable.isSecret !== false) failures.push(`Registry ${contract.name} secrecy flag drift`);
  }
  for (const forbiddenName of ['HYTHE_AGENT_KEY', 'HYTHE_AGENT_TOKEN']) {
    if (registryEnvironment.some((entry) => entry?.name === forbiddenName)) {
      failures.push(`Registry must not expose raw agent secret variable ${forbiddenName}`);
    }
  }
  const registryApiKey = registryEnvironment.find((entry) => entry?.name === 'API_KEY');
  if (!registryApiKey?.description?.includes(`npx -y ${exactPackageSpec} init`)) {
    failures.push('Registry API_KEY setup command is not pinned to the release package');
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
  const publicInitExamples = envExample.split(/\r?\n/).filter((line) => /\bnpx\s+-y\s+@hythe\/mcp(?:@[^\s]+)?\s+init\b/.test(line));
  if (publicInitExamples.length === 0) failures.push('.env.example public init example missing');
  if (publicInitExamples.some((line) => !/--agent-id(?:\s|=)/.test(line))) {
    failures.push('.env.example contains identity-less public init command');
  }
  if (publicInitExamples.some((line) => !line.includes(exactPackageSpec))) {
    failures.push('.env.example contains an unpinned public init command');
  }
  if (!envExample.includes('HYTHE_AGENT_ID')) {
    failures.push('.env.example does not explain the per-client HYTHE_AGENT_ID requirement');
  }
  if (envExample.split(/\r?\n/).some((line) => /^\s*HYTHE_AGENT_ID\s*=/.test(line))) {
    failures.push('.env.example must not assign a shared server-wide agent identity');
  }
  const readme = read('README.md');
  if (!readme.startsWith('# HYTHE\n')) failures.push('README identity drift');
  if (!readme.includes(`**Version ${expectedPackageVersion}.**`)) {
    failures.push('README release version drift');
  }
  const changelog = read('CHANGELOG.md');
  if (!changelog.includes(`## ${expectedPackageVersion} - 2026-09-05`)) {
    failures.push('CHANGELOG release version drift');
  }
  const security = read('SECURITY.md');
  if (!security.includes(`## ${expectedPackageVersion} dual-proof agent authorization`)) {
    failures.push('SECURITY dual-proof release marker drift');
  }
  const quickstart = read('docs/QUICKSTART.md');
  if (!quickstart.includes('`observe`-mode compatibility bootstrap')
      || !quickstart.includes('observe → mixed → required')
      || !quickstart.includes('./AGENT-CREDENTIAL-OPERATOR.md')) {
    failures.push('Quickstart complete agent-authorization rollout guidance drift');
  }
  if (!quickstart.includes(`--branch v${expectedPackageVersion}`)
      || !quickstart.includes('https://github.com/hythe-dev/hythe.git')) {
    failures.push('Quickstart buildable server checkout guidance drift');
  }
  if (!quickstart.includes(exactPackageSpec)
      || /npx\s+-y\s+@hythe\/mcp(?!@)/.test(quickstart)) {
    failures.push('Quickstart contains an unpinned HYTHE client command');
  }
  const codexSnippet = read('clients/agent-kit/codex/config-snippet.toml');
  if (!codexSnippet.includes(`args = ["-y", "${exactPackageSpec}"]`)) {
    failures.push('Codex agent-kit config is not pinned to the release package');
  }
  const concepts = read('docs/CONCEPTS.md');
  if (concepts.includes('per-agent authorization scopes are future work')
      || !concepts.includes('per-agent credential')) {
    failures.push('Concepts per-agent authorization model drift');
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
