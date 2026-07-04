// Production build (deployment plan §4.4): bundle the API into dist/server.js.
// @hearth/shared is inlined (its package entry is TypeScript source, so it
// can't be imported at runtime); everything in dependencies stays external and
// comes from the image's production node_modules — most importantly
// @prisma/client, whose generated code + native engine can't be bundled.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { apiRoot } from './pg';

const pkg = JSON.parse(readFileSync(path.join(apiRoot, 'package.json'), 'utf-8')) as {
  dependencies: Record<string, string>;
};

await build({
  entryPoints: [path.join(apiRoot, 'src/server.ts')],
  outfile: path.join(apiRoot, 'dist/server.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external: Object.keys(pkg.dependencies).filter((d) => d !== '@hearth/shared'),
});

console.log('[build] apps/api → dist/server.js');
