/**
 * SheetBot sheetTheme -> Univer 构造参数（darkMode + 完整 theme 色彩词元）
 *
 * Univer new Univer({theme, darkMode}) 构造函数直接消费这两个字段：
 *   - theme:    替换 ThemeService 的全量色板（spread defaultTheme 后覆盖 primary/gray）
 *   - darkMode: 在 document.documentElement 上切换 .univer-dark 并触发深色 CSS vars
 */
import { defaultTheme } from '@univerjs/themes'

// ==================== 光亮主题公用调色 ====================

/** MS Excel 经典：标准白底，保留 Univer 默认蓝色选区 */
const EXCEL_CLASSIC_THEME = {
  ...defaultTheme,
  // 使用 Univer 默认 defaultTheme 即可；这里保持显式以示意图没有自定义覆盖
}

/** 冰川蓝：浅蓝灰色调，行列表头和网格都带蓝意 */
const GLACIER_BLUE_THEME = {
  ...defaultTheme,
  primary: {
    50:  '#EFF4FF',
    100: '#DBE9FE',
    200: '#BFDBFE',
    300: '#93C5FD',
    400: '#60A5FA',
    500: '#3B82F6',
    600: '#2563EB',
    700: '#1D4ED8',
    800: '#1E40AF',
    900: '#1E3A8A',
  },
  gray: {
    50:  '#F0F4FF',
    100: '#E0EBFF',
    200: '#C7D9FF',
    300: '#9FB8F5',
    400: '#7294E0',
    500: '#4D6EC5',
    600: '#2F50A8',
    700: '#1E3680',
    800: '#122158',
    900: '#091035',
  },
}

/** 薄荷对比：浅绿调，长时录入护眼 */
const MINT_CONTRAST_THEME = {
  ...defaultTheme,
  primary: {
    50:  '#F0FDF4',
    100: '#DCFCE7',
    200: '#BBF7D0',
    300: '#86EFAC',
    400: '#4ADE80',
    500: '#22C55E',
    600: '#16A34A',
    700: '#15803D',
    800: '#166534',
    900: '#14532D',
  },
  gray: {
    50:  '#EDFAF3',
    100: '#D4F5E3',
    200: '#AEEACC',
    300: '#79D9AD',
    400: '#47C28A',
    500: '#2BA670',
    600: '#1A8258',
    700: '#115E40',
    800: '#0A3E2A',
    900: '#052518',
  },
}

/**
 * OLED 夜间：近纯黑底，高对比白字。
 *
 * gray 必须遵循 Univer 约定（50=最浅，900=最深），否则 darkMode=true 下
 * CSS 深色变量（dark:!univer-bg-gray-800 等）会取到错误的浅色，导致背景
 * 反白、文字混乱。与 sheetbot-dark 的区别在于把深色端压向纯黑（000005），
 * Canvas 单元格背景更暗、对比更极致。
 */
const OLED_NIGHT_THEME = {
  ...defaultTheme,
  gray: {
    50:  '#F6F6F8',
    100: '#E6E6EA',
    200: '#CCCCD4',
    300: '#9C9CAA',
    400: '#6A6A7A',
    500: '#3C3C4A',
    600: '#1E1E28',
    700: '#101018',
    800: '#06060C',
    900: '#000005',
  },
}

// ==================== 主题映射表 ====================

const THEME_MAP = {
  'sheetbot-dark':  { darkMode: true,  theme: defaultTheme },
  'excel-classic':  { darkMode: false, theme: EXCEL_CLASSIC_THEME },
  'glacier-blue':   { darkMode: false, theme: GLACIER_BLUE_THEME },
  'mint-contrast':  { darkMode: false, theme: MINT_CONTRAST_THEME },
  'oled-night':     { darkMode: true,  theme: OLED_NIGHT_THEME },
}

/**
 * @param {string} sheetTheme
 * @returns {{ darkMode: boolean, theme: object }}
 */
export function sheetThemeToUniverOptions(sheetTheme) {
  const key = String(sheetTheme || '').toLowerCase()
  return THEME_MAP[key] ?? THEME_MAP['excel-classic']
}
