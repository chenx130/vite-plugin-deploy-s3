import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  entries: ['src/main'],
  externals: ['vite'],
  clean: true,
  declaration: 'compatible',
  rollup: {
    emitCJS: true,
    inlineDependencies: true,
  },
  outDir: 'dist',
})