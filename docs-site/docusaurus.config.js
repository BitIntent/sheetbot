// @ts-check

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'SheetBot 用户手册',
  tagline: '重新定义AI时代办公范式',
  url: 'http://localhost',
  baseUrl: '/help/',
  onBrokenLinks: 'warn',
  onBrokenAnchors: 'warn',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
      onBrokenMarkdownImages: 'warn'
    }
  },
  trailingSlash: false,
  i18n: {
    defaultLocale: 'zh-Hans',
    locales: ['zh-Hans'],
    localeConfigs: {
      'zh-Hans': {
        label: '简体中文'
      }
    }
  },
  presets: [
    [
      'classic',
      {
        docs: {
          path: 'docs',
          routeBasePath: '/',
          sidebarPath: require.resolve('./sidebars.js'),
          showLastUpdateTime: false,
          numberPrefixParser: false
        },
        blog: false,
        pages: false,
        theme: {
          customCss: require.resolve('./src/css/custom.css')
        }
      }
    ]
  ],
  themeConfig: {
    colorMode: {
      defaultMode: 'dark',
      disableSwitch: false,
      respectPrefersColorScheme: false
    },
    navbar: {
      title: 'SheetBot',
      items: [
        {
          href: '/',
          label: '返回首页',
          position: 'right'
        }
      ]
    },
    docs: {
      sidebar: {
        hideable: false,
        autoCollapseCategories: false
      }
    }
  }
};

module.exports = config;
