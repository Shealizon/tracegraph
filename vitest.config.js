import { defineConfig } from 'vitest/config';

// 测试仅覆盖纯逻辑层（无 DOM 依赖）：data / import / model / project
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['src/data/**', 'src/import/**', 'src/model/**', 'src/project/**'],
      // 排除 DOM/IO 副作用层（弹窗 UI、IndexedDB），只统计纯逻辑覆盖率
      exclude: ['**/*.json', 'src/project/projectConfig.js', 'src/project/store.js'],
      reporter: ['text', 'text-summary'],
    },
  },
});
