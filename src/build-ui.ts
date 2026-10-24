import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
export async function buildUI() {
  const result = await Bun.build({
    entrypoints: [resolve(root, 'web/app.js')],
    outdir: resolve(root, 'web/dist'),
    target: 'browser', format: 'esm', minify: true,
    naming: '[name].[ext]',
  });
  if (!result.success) throw new AggregateError(result.logs, 'DialKit UI build failed');
  return result;
}
if (import.meta.main) {
  const result = await buildUI();
  console.log(`Built DialKit UI: ${result.outputs.map(file => file.path.split('/').pop()).join(', ')}`);
}
