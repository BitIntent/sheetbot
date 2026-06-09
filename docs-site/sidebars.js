/**
 * 手工维护的手册导航（纯 Docusaurus Node 链路）。
 */
const sidebars = {
  tutorialSidebar: [
    {
      type: 'category',
      label: '基础入门',
      collapsed: false,
      link: {
        type: 'generated-index',
        slug: '/manual-base',
        title: '基础入门'
      },
      items: ['00-目录', '01-产品概览', '02-快速开始']
    },
    {
      type: 'category',
      label: '功能详解',
      collapsed: false,
      link: {
        type: 'generated-index',
        slug: '/manual-views',
        title: '功能详解'
      },
      items: [
        '03-普通视图',
        '04-我要分析',
        '05-我要汇报',
        '06-我要报表',
        '07-我要收集',
        '08-我要连接',
        '09-批量转Word',
        '10-玩数据Skill'
      ]
    },
    {
      type: 'category',
      label: '进阶说明',
      collapsed: false,
      link: {
        type: 'generated-index',
        slug: '/manual-advanced',
        title: '进阶说明'
      },
      items: ['11-使用案例', '12-技术支持', '13-商业方案', '14-常见问题']
    }
  ]
};

module.exports = sidebars;
