#!/usr/bin/env node
/** Fail closed when a public HYTHE source tree drifts from its P2 identity. */
import { readFileSync } from 'node:fs';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const pkg = readJson('package.json');
const server = readJson('server.json');
const failures = [];
if (pkg.name !== '@hythe/mcp') failures.push(`package name: ${pkg.name}`);
if (pkg.version !== '0.1.2') failures.push(`package version: ${pkg.version}`);
if (pkg.mcpName !== 'dev.hythe/hythe') failures.push(`mcpName: ${pkg.mcpName}`);
if (pkg.private === true) failures.push('package remains private:true');
if (JSON.stringify(pkg.bin) !== JSON.stringify({ 'hythe-mcp': 'bin/engram-mcp.cjs' })) failures.push('bin map drift');
if (server.name !== pkg.mcpName) failures.push('server name != package mcpName');
if (server.version !== pkg.version) failures.push('server version != package version');
if (server.packages?.[0]?.identifier !== pkg.name) failures.push('Registry package identifier drift');
if (Object.keys(server).some((key) => key.startsWith('x-hythe-p1'))) failures.push('P1 Registry marker present');
if (!readFileSync('README.md', 'utf8').startsWith('# HYTHE\n')) failures.push('README identity drift');
if (failures.length) {
  process.stderr.write(`HYTHE P2 release-tree verification failed:\n- ${failures.join('\n- ')}\n`);
  process.exit(1);
}
process.stdout.write('HYTHE P2 release-tree verification passed; no publish action performed.\n');
