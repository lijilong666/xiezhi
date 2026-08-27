import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: false,
  // Runtime value imports stay external (resolved from the installed dsh
  // profile); every other workspace import is type-only and erased.
  external: ['@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery', '@deepseek-ai/cordis'],
  root: import.meta.dirname,
})
