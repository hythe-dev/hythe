import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { verifyReleaseTree } from './verify-hythe-release-tree.mjs';

const writeJson = (root, path, value) => {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
};

const makeTree = (version = '9.8.7') => {
  const root = mkdtempSync(join(tmpdir(), 'hythe-release-tree-'));
  writeJson(root, 'package.json', {
    name: '@hythe/mcp',
    version,
    mcpName: 'dev.hythe/hythe',
    bin: { 'hythe-mcp': 'bin/engram-mcp.cjs' },
    files: ['bin/', 'dist/', 'docker/', 'docs/', 'mcp-stdio-http-bridge.cjs'],
    dependencies: {},
    devDependencies: { '@xenova/transformers': '2.17.2' },
    peerDependencies: { '@xenova/transformers': '2.17.2' },
    peerDependenciesMeta: { '@xenova/transformers': { optional: true } },
    overrides: { protobufjs: '7.6.5', sharp: '0.35.3' },
    scripts: {
      prepack: 'npm run build && node scripts/verify-hythe-release-tree.mjs',
      'migrate:private-message-residue': 'node dist/migrations/007-private-message-residue.mjs',
    },
  });
  writeJson(root, 'package-lock.json', {
    name: '@hythe/mcp',
    version,
    packages: {
      '': {
        name: '@hythe/mcp',
        version,
        dependencies: {},
        devDependencies: { '@xenova/transformers': '2.17.2' },
        peerDependencies: { '@xenova/transformers': '2.17.2' },
        peerDependenciesMeta: { '@xenova/transformers': { optional: true } },
      },
    },
  });
  writeJson(root, 'docker/transformers-runtime/package.json', {
    name: '@hythe/transformers-runtime',
    version,
    private: true,
    dependencies: { '@xenova/transformers': '2.17.2' },
    overrides: { protobufjs: '7.6.5', sharp: '0.35.3' },
  });
  writeJson(root, 'docker/transformers-runtime/package-lock.json', {
    name: '@hythe/transformers-runtime',
    version,
    packages: {
      '': {
        name: '@hythe/transformers-runtime',
        version,
        dependencies: { '@xenova/transformers': '2.17.2' },
      },
      'node_modules/protobufjs': { version: '7.6.5' },
      'node_modules/sharp': { version: '0.35.3' },
    },
  });
  writeFileSync(join(root, 'docker/transformers-runtime/.npmignore'), 'node_modules/\n');
  writeFileSync(
    join(root, 'docker/Dockerfile'),
    'COPY docker/transformers-runtime/package.json docker/transformers-runtime/package-lock.json ./\n'
      + 'RUN npm ci --omit=dev && npm audit --omit=dev --audit-level=high\n'
      + 'ENV SQLITE_VEC_TRANSFORMERS_MODULE=file:///opt/hythe-transformers/node_modules/@xenova/transformers/src/transformers.js \\\n'
      + '    SQLITE_VEC_REQUIRE_TRANSFORMERS=true\n'
      + 'CMD ["sh", "-c", "node docker/verify-transformer-runtime.mjs && exec node dist/unified-neural-mcp-server.js"]\n'
  );
  writeFileSync(
    join(root, 'docker/verify-transformer-runtime.mjs'),
    "await pipelineFactory('feature-extraction', model, { dtype: 'q8' });\nif (values.length !== dimensions) throw new Error();\n"
  );
  const vectorClient = join(root, 'src/memory/sqlite-vec-client.ts');
  mkdirSync(dirname(vectorClient), { recursive: true });
  writeFileSync(vectorClient, 'SQLITE_VEC_TRANSFORMERS_MODULE\nSQLITE_VEC_REQUIRE_TRANSFORMERS\n');
  writeJson(root, 'server.json', {
    name: 'dev.hythe/hythe',
    version,
    packages: [{
      registryType: 'npm',
      identifier: '@hythe/mcp',
      version,
      environmentVariables: [{
        name: 'HYTHE_AGENT_ID',
        description: 'Stable exact client-lane identity',
        isRequired: true,
        format: 'string',
        isSecret: false,
      }],
    }],
  });
  writeJson(root, '.claude-plugin/marketplace.json', {
    plugins: [{
      name: 'hythe',
      version: '0.1.1',
      source: './clients/agent-kit/claude-code/plugin',
    }],
  });
  const agentKitScripts = join(root, 'clients/agent-kit/claude-code/plugin/scripts');
  mkdirSync(agentKitScripts, { recursive: true });
  writeFileSync(join(agentKitScripts, 'resolve-agent-id.sh'), '# identity resolver fixture\n');
  for (const hook of ['session-start.sh', 'post-compaction.sh']) {
    writeFileSync(join(agentKitScripts, hook), 'source "$SCRIPT_DIR/resolve-agent-id.sh"\n');
  }
  writeFileSync(
    join(root, '.env.example'),
    '# npx -y @hythe/mcp init --write-env --agent-id <agent-id>\n'
      + '# HYTHE_AGENT_ID is required in each individual client configuration.\n'
  );
  writeFileSync(join(root, 'README.md'), `# HYTHE\n\nThis is the \`${version}\` release candidate.\n`);
  const migrationSource = join(root, 'src/migrations/007-private-message-residue.mjs');
  const migrationArtifact = join(root, 'dist/migrations/007-private-message-residue.mjs');
  mkdirSync(dirname(migrationSource), { recursive: true });
  mkdirSync(dirname(migrationArtifact), { recursive: true });
  writeFileSync(migrationSource, '// source migration fixture\n');
  writeFileSync(migrationArtifact, '// packed migration fixture\n');
  const migrationDocumentation = join(root, 'docs/PRIVATE-MESSAGE-RESIDUE-MIGRATION.md');
  mkdirSync(dirname(migrationDocumentation), { recursive: true });
  writeFileSync(
    migrationDocumentation,
    '# Migration\n\nnode dist/migrations/007-private-message-residue.mjs /path/to/memory.db\n'
  );
  return root;
};

const withTree = (fn) => {
  const root = makeTree();
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test('derives the MCP release version from package.json', () => {
  withTree((root) => {
    const result = verifyReleaseTree(root);
    assert.deepEqual(result, { expectedPackageVersion: '9.8.7', failures: [] });
  });
});

for (const regression of [
  {
    name: 'missing npm bridge payload',
    path: 'package.json',
    mutate: (value) => { value.files = value.files.filter((entry) => entry !== 'mcp-stdio-http-bridge.cjs'); },
    error: /npm package files missing: mcp-stdio-http-bridge\.cjs/,
  },
  {
    name: 'missing packed operator documentation directory',
    path: 'package.json',
    mutate: (value) => { value.files = value.files.filter((entry) => entry !== 'docs/'); },
    error: /npm package files missing: docs\//,
  },
  {
    name: 'root lockfile version drift',
    path: 'package-lock.json',
    mutate: (value) => { value.version = '9.8.6'; },
    error: /lockfile version != package version/,
  },
  {
    name: 'missing prepack build gate',
    path: 'package.json',
    mutate: (value) => { delete value.scripts.prepack; },
    error: /prepack build\/release verification drift/,
  },
  {
    name: 'transformer restored as a published production dependency',
    path: 'package.json',
    mutate: (value) => { value.dependencies['@xenova/transformers'] = '2.17.2'; },
    error: /published package must not install the transformer runtime as a production dependency/,
  },
  {
    name: 'required published transformer peer',
    path: 'package.json',
    mutate: (value) => { value.peerDependenciesMeta['@xenova/transformers'].optional = false; },
    error: /published transformer peer must remain optional/,
  },
  {
    name: 'Docker transformer runtime override drift',
    path: 'docker/transformers-runtime/package.json',
    mutate: (value) => { value.overrides.protobufjs = '6.11.6'; },
    error: /Docker transformer runtime security overrides drift/,
  },
  {
    name: 'Docker transformer lockfile override drift',
    path: 'docker/transformers-runtime/package-lock.json',
    mutate: (value) => { value.packages['node_modules/sharp'].version = '0.32.6'; },
    error: /Docker transformer lockfile sharp override missing/,
  },
  {
    name: 'source-only private migration command',
    path: 'package.json',
    mutate: (value) => {
      value.scripts['migrate:private-message-residue'] = 'node src/migrations/007-private-message-residue.mjs';
    },
    error: /private-message residue migration command does not use packed dist artifact/,
  },
  {
    name: 'nested lockfile version drift',
    path: 'package-lock.json',
    mutate: (value) => { value.packages[''].version = '9.8.6'; },
    error: /lockfile root package version != package version/,
  },
  {
    name: 'server package identifier drift',
    path: 'server.json',
    mutate: (value) => { value.packages[0].identifier = '@hythe/wrong'; },
    error: /Registry package identifier != package name/,
  },
  {
    name: 'nested server package version drift',
    path: 'server.json',
    mutate: (value) => { value.packages[0].version = '9.8.6'; },
    error: /Registry package version != package version/,
  },
  {
    name: 'missing registry-bound agent identity',
    path: 'server.json',
    mutate: (value) => { value.packages[0].environmentVariables = []; },
    error: /Registry HYTHE_AGENT_ID entry count drift/,
  },
  {
    name: 'optional registry-bound agent identity',
    path: 'server.json',
    mutate: (value) => { value.packages[0].environmentVariables[0].isRequired = false; },
    error: /Registry HYTHE_AGENT_ID must be required/,
  },
  {
    name: 'secret registry-bound agent identity',
    path: 'server.json',
    mutate: (value) => { value.packages[0].environmentVariables[0].isSecret = true; },
    error: /Registry HYTHE_AGENT_ID secrecy flag drift/,
  },
  {
    name: 'wrong registry-bound agent identity format',
    path: 'server.json',
    mutate: (value) => { value.packages[0].environmentVariables[0].format = 'path'; },
    error: /Registry HYTHE_AGENT_ID format drift/,
  },
  {
    name: 'agent-kit marketplace asset version drift',
    path: '.claude-plugin/marketplace.json',
    mutate: (value) => { value.plugins[0].version = '0.1.0'; },
    error: /Claude marketplace agent-kit asset version: 0\.1\.0 \(expected 0\.1\.1\)/,
  },
]) {
  test(`rejects ${regression.name}`, () => {
    withTree((root) => {
      const path = join(root, regression.path);
      const value = JSON.parse(readFileSync(path, 'utf8'));
      regression.mutate(value);
      writeJson(root, regression.path, value);
      const result = verifyReleaseTree(root);
      assert.match(result.failures.join('\n'), regression.error);
    });
  });
}

test('rejects an identity-less public init example', () => {
  withTree((root) => {
    writeFileSync(
      join(root, '.env.example'),
      '# npx -y @hythe/mcp init --write-env\n# HYTHE_AGENT_ID is per-client.\n'
    );
    const result = verifyReleaseTree(root);
    assert.match(result.failures.join('\n'), /.env.example contains identity-less public init command/);
  });
});

test('rejects a shared server-wide agent identity assignment', () => {
  withTree((root) => {
    const path = join(root, '.env.example');
    writeFileSync(path, `${readFileSync(path, 'utf8')}HYTHE_AGENT_ID=codex-hythe\n`);
    const result = verifyReleaseTree(root);
    assert.match(result.failures.join('\n'), /must not assign a shared server-wide agent identity/);
  });
});

test('rejects a release tree missing the packed migration artifact', () => {
  withTree((root) => {
    rmSync(join(root, 'dist/migrations/007-private-message-residue.mjs'));
    const result = verifyReleaseTree(root);
    assert.match(
      result.failures.join('\n'),
      /private-message residue migration packed artifact missing/
    );
  });
});

test('rejects operator documentation that points at unpacked source', () => {
  withTree((root) => {
    writeFileSync(
      join(root, 'docs/PRIVATE-MESSAGE-RESIDUE-MIGRATION.md'),
      '# Migration\n\nnode src/migrations/007-private-message-residue.mjs /path/to/memory.db\n'
    );
    const result = verifyReleaseTree(root);
    assert.match(
      result.failures.join('\n'),
      /documentation omits packed dist command/
    );
    assert.match(
      result.failures.join('\n'),
      /documentation exposes unpacked source command/
    );
  });
});

test('rejects stale README release-candidate identity', () => {
  withTree((root) => {
    writeFileSync(join(root, 'README.md'), '# HYTHE\n\nThis is the `9.8.6` release candidate.\n');
    const result = verifyReleaseTree(root);
    assert.match(result.failures.join('\n'), /README release-candidate version drift/);
  });
});

test('rejects a marketplace tree missing the shared identity resolver asset', () => {
  withTree((root) => {
    rmSync(join(root, 'clients/agent-kit/claude-code/plugin/scripts/resolve-agent-id.sh'));
    const result = verifyReleaseTree(root);
    assert.match(result.failures.join('\n'), /Claude marketplace identity resolver asset missing/);
  });
});
