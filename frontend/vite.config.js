import { defineConfig } from 'vite'
import path, { resolve } from 'path'
import { fileURLToPath, URL } from 'node:url'
import veauryVitePlugins from 'veaury/vite/index.js'
import Icons from 'unplugin-icons/vite'
import { FileSystemIconLoader } from 'unplugin-icons/loaders'
import IconsResolver from 'unplugin-icons/resolver'
import Components from 'unplugin-vue-components/vite'

const envDir = path.resolve(__dirname, '..')

// ============================================================================
// Vite 配置 - React 主框架 + PPTist Vue 子系统共存
// veaury type:'react' 模式：
//   - .vue 文件及 vue_app/ 目录下的 jsx/tsx 按 Vue 解析
//   - 其余 jsx 按 React 解析
// ============================================================================

export default defineConfig({
  plugins: [
    veauryVitePlugins({
      type: 'react',
      vueOptions: {},
      reactOptions: {},
    }),
    Components({
      dirs: [],
      resolvers: [
        IconsResolver({
          prefix: 'i',
          customCollections: ['custom'],
        }),
      ],
    }),
    Icons({
      compiler: 'vue3',
      autoInstall: false,
      customCollections: {
        custom: FileSystemIconLoader(
          path.resolve(__dirname, 'src/pptist-vue/assets/icons')
        ),
      },
      scale: 1,
      defaultClass: 'i-icon',
    }),
  ],
  envDir,
  server: {
    port: 80,
    host: '0.0.0.0',
    // 性能优化：依赖预构建，减少请求数
    preTransformRequests: true,
  },
  // 性能优化：预打包依赖，避免单个文件请求
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-router-dom',
      'rxjs',
      '@univerjs/preset-sheets-core',
      '@univerjs/core',
      'vue',
      'pinia',
      'veaury',
      'lucide-react',
      'exceljs',
      'axios',
      'uuid',
      'recharts',
      'react-markdown',
      'prosemirror-commands',
      'prosemirror-history',
      'prosemirror-keymap',
      'prosemirror-model',
      'prosemirror-state',
      'prosemirror-view',
      'pptxtojson',
      'nanoid',
      'lodash-es',
    ],
    exclude: [],
    force: false,
    esbuildOptions: {
      target: 'es2020',
    },
  },
  esbuild: {
    target: 'es2020',
    minifyWhitespace: true,
  },
  css: {
    preprocessorOptions: {
      scss: {
        // 第 1 层风格适配：先导入原始变量，再覆盖核心色值
        additionalData: `
          @import '@pptist/assets/styles/variable.scss';
          @import '@pptist/assets/styles/mixin.scss';
          $themeColor: #217346;
          $themeHoverColor: #2A9058;
          $textColor: #E5E5E5;
          $borderColor: #333333;
          $lightGray: #2A2A2A;
          $borderRadius: 4px;
          $boxShadow: 0 4px 6px -1px rgba(0, 0, 0, .3), 0 2px 4px -2px rgba(0, 0, 0, .2);
        `,
      },
    },
  },
  resolve: {
    dedupe: [
      '@wendellhu/redi',
      '@univerjs/core',
      '@univerjs/engine-render',
      '@univerjs/ui',
      '@univerjs/sheets',
      '@univerjs/sheets-ui',
      'rxjs',
    ],
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@pptist': fileURLToPath(new URL('./src/pptist-vue', import.meta.url)),
    },
  },
  build: {
    // 先确保生产构建稳定：当前环境下 CSS 压缩阶段存在语法警告并触发高内存峰值
    // 后续定位到具体 CSS 源后可再恢复压缩
    cssMinify: false,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        form: resolve(__dirname, 'form.html'),
      },
      output: {
        manualChunks: {
          'pptist-core': [
            './src/pptist-vue/store/main.ts',
            './src/pptist-vue/store/slides.ts',
            './src/pptist-vue/store/snapshot.ts',
            './src/pptist-vue/store/keyboard.ts',
            './src/pptist-vue/store/screen.ts',
          ],
          'vendor-vue': ['vue', 'pinia', 'veaury'],
          'vendor-prosemirror': [
            'prosemirror-commands',
            'prosemirror-history',
            'prosemirror-keymap',
            'prosemirror-model',
            'prosemirror-state',
            'prosemirror-view',
          ],
        },
      },
    },
  },
})
