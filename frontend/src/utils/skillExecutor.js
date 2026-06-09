/**
 * 技能执行引擎
 *
 * Skill 对整个文件生效，不依赖选区。
 * 执行时按 scope 决定操作哪些 Sheet，对每个 Sheet 构建变量上下文，
 * 替换步骤 params 中的 {{变量}}，再通过翻译层转换为底层操作后执行。
 *
 * 双层操作模型：
 *   新版技能 (set_font, batch_fill...) -> translateSkillOp -> 底层操作
 *   旧版操作 (set_range_style...) -> 直接执行（向后兼容）
 */

import { translateSkillOp } from './skillTranslator'
import { isNewSkillType, isLegacyOp } from '../components/skillOperationConfigs'

// ----------------------------------------------------------------
// 变量替换
// ----------------------------------------------------------------

/**
 * 递归替换 params 对象中的 {{变量}} 占位符
 * @param {*} value - 任意类型的参数值
 * @param {object} ctx - {
 *   sheet: { name, firstRow, lastRow, firstCol, lastCol, firstColLetter, lastColLetter, range },
 *   file: { name, sheetCount }
 * }
 * @returns 替换后的值
 */
export function substituteVars(value, ctx) {
  if (typeof value === 'string') {
    // 整个字符串就是单个变量时，直接返回原始类型（保留数字、布尔等）
    const singleVarMatch = value.match(/^\{\{([^}]+)\}\}$/)
    if (singleVarMatch) {
      const parts = singleVarMatch[1].trim().split('.')
      let result = ctx
      for (const part of parts) {
        if (result == null) return value
        result = result[part]
      }
      return result != null ? result : value
    }
    // 含多个变量或混合文本时，全部字符串替换
    return value.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
      const parts = path.trim().split('.')
      let result = ctx
      for (const part of parts) {
        if (result == null) return `{{${path}}}`
        result = result[part]
      }
      return result != null ? result : `{{${path}}}`
    })
  }
  if (Array.isArray(value)) {
    return value.map(item => substituteVars(item, ctx))
  }
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = substituteVars(v, ctx)
    }
    return out
  }
  return value
}

// ----------------------------------------------------------------
// Sheet 范围计算
// ----------------------------------------------------------------

/**
 * 计算 Sheet 的实际使用范围，构建变量上下文
 */
function buildSheetContext(sheet, workbook) {
  const colNumToLetter = (colNum) => {
    let result = ''
    let n = Number(colNum) || 0
    while (n > 0) {
      n -= 1
      result = String.fromCharCode(65 + (n % 26)) + result
      n = Math.floor(n / 26)
    }
    return result || 'A'
  }

  let firstRow = 1, lastRow = 1, firstCol = 1, lastCol = 1

  if (sheet?.data && Object.keys(sheet.data).length > 0) {
    const rowNums = Object.keys(sheet.data).map(Number).filter(n => !isNaN(n))
    if (rowNums.length) {
      firstRow = Math.min(...rowNums)
      lastRow = Math.max(...rowNums)
    }
    let colMin = Infinity, colMax = 0
    for (const rowData of Object.values(sheet.data)) {
      if (!rowData) continue
      for (const colKey of Object.keys(rowData)) {
        const c = parseInt(colKey)
        if (!isNaN(c)) {
          if (c < colMin) colMin = c
          if (c > colMax) colMax = c
        }
      }
    }
    if (colMax > 0) {
      firstCol = colMin === Infinity ? 1 : colMin
      lastCol = colMax
    }
  }

  return {
    sheet: {
      name: sheet?.name || '',
      firstRow,
      lastRow,
      firstCol,
      lastCol,
      firstColLetter: colNumToLetter(firstCol),
      lastColLetter: colNumToLetter(lastCol),
      range: `${colNumToLetter(firstCol)}${firstRow}:${colNumToLetter(lastCol)}${lastRow}`,
    },
    file: {
      name: workbook?.fileName || '',
      sheetCount: workbook?.sheets?.length || 1,
    },
  }
}

// ----------------------------------------------------------------
// 单 Sheet 执行
// ----------------------------------------------------------------

/**
 * 在指定 Sheet 上执行 Skill 的全部步骤
 * @param {Array} steps - 步骤数组
 * @param {object} sheet - workbook.sheets[i]
 * @param {object} workbook - 完整 workbook
 * @param {Function} execFn - executeOperation(workbook, operation) => newWorkbook
 * @returns {object} 更新后的 workbook
 */
export function executeSkillOnSheet(steps, sheet, workbook, execFn) {
  const ctx = buildSheetContext(sheet, workbook)
  let currentWorkbook = workbook

  for (const step of steps) {
    const resolvedParams = substituteVars(step.params || {}, ctx)
    const opType = step.operation_type

    try {
      if (isNewSkillType(opType)) {
        // 新版技能 -> 翻译层 -> 一个或多个底层操作
        const translated = translateSkillOp(opType, resolvedParams)
        if (!translated) continue
        const rawOps = Array.isArray(translated) ? translated : [translated]
        for (const rawOp of rawOps) {
          const operation = {
            type: rawOp.type,
            params: { sheetName: sheet.name, sheet: sheet.name, ...rawOp.params },
          }
          currentWorkbook = execFn(currentWorkbook, operation)
        }
      } else {
        // 旧版操作 -> 直接执行（向后兼容）
        const operation = {
          type: opType,
          params: { sheetName: sheet.name, ...resolvedParams },
        }
        currentWorkbook = execFn(currentWorkbook, operation)
      }
    } catch (err) {
      console.warn(`[SkillExecutor] 步骤 "${step.label}" 执行失败:`, err)
    }
  }

  return currentWorkbook
}

// ----------------------------------------------------------------
// 文件级执行入口
// ----------------------------------------------------------------

/**
 * 执行 Skill（文件级，按 scope 决定目标 Sheet）
 * @param {object} skill - { steps, scope: { mode, sheet? } }
 * @param {object} workbook - 当前 workbook 状态
 * @param {Function} execFn - (workbook, operation) => newWorkbook
 * @returns {object} 执行完毕后的 workbook
 */
export function executeSkill(skill, workbook, execFn) {
  const { steps = [], scope = { mode: 'all_sheets' } } = skill
  if (!steps.length) return workbook

  const sheets = workbook?.sheets || []
  if (!sheets.length) return workbook

  // 确定目标 Sheet 列表
  const targets = scope.mode === 'named_sheet' && scope.sheet
    ? sheets.filter(s => s.name === scope.sheet)
    : sheets

  let currentWorkbook = workbook
  for (const sheet of targets) {
    currentWorkbook = executeSkillOnSheet(steps, sheet, currentWorkbook, execFn)
  }

  return currentWorkbook
}
