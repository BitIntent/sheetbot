// frontend/src/utils/operationValidator.js
/**
 * 操作参数验证模块
 * 验证从后端接收的Excel操作参数的有效性
 *
 * 所有已知操作类型由 operationRegistry.js 统一定义（单一真相源）。
 *
 * 宪法级约束（前端校验侧）：
 * 1) 禁止按行业/表头硬编码校验分支（如“销售额/客户/订单”特判）。
 * 2) 校验优先使用结构化契约（operation type + required params + 行列范围）。
 * 3) 新场景扩展通过注册表与通用规则完成，禁止临时 if/else 补丁。
 * 4) 任何业务语义判断属于上层策略，不应下沉到参数校验器。
 */
import {
  KNOWN_OPERATIONS, OPERATION_ALIASES,
  resolveOperationType, isKnownOperation, getRequiredParams,
} from './operationRegistry.js'

const MAX_ROW = 1000000
const MAX_COL = 16384
const MIN_ROW = 1
const MIN_COL = 1

/**
 * camelCase / PascalCase -> snake_case 操作类型名
 * 再经 resolveOperationType 消解别名
 */
export function normalizeOperationType(type) {
  if (!type || typeof type !== 'string') return type
  let t = type
  if (/[A-Z]/.test(t)) {
    t = t.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase()
  }
  return resolveOperationType(t)
}

/**
 * 验证工作表是否存在
 */
function validateSheetExists(workbook, sheetName) {
  const errors = []
  
  if (!sheetName || typeof sheetName !== 'string') {
    errors.push(`工作表名称无效: ${sheetName}`)
    return errors
  }
  
  if (!workbook || !workbook.sheets) {
    errors.push('工作簿不存在或无效')
    return errors
  }
  
  const sheet = workbook.sheets.find(s => s.name === sheetName)
  if (!sheet) {
    const sheetNames = workbook.sheets.map(s => s.name).join(', ')
    errors.push(`工作表 '${sheetName}' 不存在。可用工作表: ${sheetNames || '无'}`)
  }
  
  return errors
}

/**
 * 验证行号
 */
function validateRowNumber(row) {
  const errors = []
  
  const rowNum = typeof row === 'number' ? row : parseInt(row)
  if (isNaN(rowNum)) {
    errors.push(`行号必须是数字，收到: ${row} (类型: ${typeof row})`)
    return errors
  }
  
  if (rowNum < MIN_ROW || rowNum > MAX_ROW) {
    errors.push(`行号必须在 ${MIN_ROW} 到 ${MAX_ROW} 之间，收到: ${rowNum}`)
  }
  
  return errors
}

/**
 * 验证列号
 */
function validateColNumber(col) {
  const errors = []
  
  const colNum = typeof col === 'number' ? col : parseInt(col)
  if (isNaN(colNum)) {
    errors.push(`列号必须是数字，收到: ${col} (类型: ${typeof col})`)
    return errors
  }
  
  if (colNum < MIN_COL || colNum > MAX_COL) {
    errors.push(`列号必须在 ${MIN_COL} 到 ${MAX_COL} 之间，收到: ${colNum}`)
  }
  
  return errors
}

/**
 * 验证单元格位置
 */
function validateCellPosition(workbook, sheet, row, col) {
  const errors = []
  
  errors.push(...validateSheetExists(workbook, sheet))
  errors.push(...validateRowNumber(row))
  errors.push(...validateColNumber(col))
  
  return errors
}

/**
 * 验证单元格范围
 */
function validateRange(workbook, sheet, startRow, startCol, endRow, endCol) {
  const errors = []
  
  errors.push(...validateSheetExists(workbook, sheet))
  
  const startRowNum = typeof startRow === 'number' ? startRow : parseInt(startRow)
  const startColNum = typeof startCol === 'number' ? startCol : parseInt(startCol)
  const endRowNum = typeof endRow === 'number' ? endRow : parseInt(endRow)
  const endColNum = typeof endCol === 'number' ? endCol : parseInt(endCol)
  
  if (isNaN(startRowNum)) {
    errors.push(`起始行号必须是数字，收到: ${startRow}`)
  } else {
    if (startRowNum < MIN_ROW || startRowNum > MAX_ROW) {
      errors.push(`起始行号必须在 ${MIN_ROW} 到 ${MAX_ROW} 之间，收到: ${startRowNum}`)
    }
  }
  
  if (isNaN(endRowNum)) {
    errors.push(`结束行号必须是数字，收到: ${endRow}`)
  } else {
    if (endRowNum < MIN_ROW || endRowNum > MAX_ROW) {
      errors.push(`结束行号必须在 ${MIN_ROW} 到 ${MAX_ROW} 之间，收到: ${endRowNum}`)
    }
  }
  
  if (!isNaN(startRowNum) && !isNaN(endRowNum) && startRowNum > endRowNum) {
    errors.push(`起始行号 (${startRowNum}) 不能大于结束行号 (${endRowNum})`)
  }
  
  if (isNaN(startColNum)) {
    errors.push(`起始列号必须是数字，收到: ${startCol}`)
  } else {
    if (startColNum < MIN_COL || startColNum > MAX_COL) {
      errors.push(`起始列号必须在 ${MIN_COL} 到 ${MAX_COL} 之间，收到: ${startColNum}`)
    }
  }
  
  if (isNaN(endColNum)) {
    errors.push(`结束列号必须是数字，收到: ${endCol}`)
  } else {
    if (endColNum < MIN_COL || endColNum > MAX_COL) {
      errors.push(`结束列号必须在 ${MIN_COL} 到 ${MAX_COL} 之间，收到: ${endColNum}`)
    }
  }
  
  if (!isNaN(startColNum) && !isNaN(endColNum) && startColNum > endColNum) {
    errors.push(`起始列号 (${startColNum}) 不能大于结束列号 (${endColNum})`)
  }
  
  return errors
}

/**
 * 验证必需参数是否存在
 */
function validateRequiredParams(params, required) {
  const errors = []
  const missing = required.filter(p => params[p] === undefined || params[p] === null)
  
  if (missing.length > 0) {
    errors.push(`缺少必需参数: ${missing.join(', ')}`)
  }
  
  return errors
}

/**
 * 规范化参数值（处理 JSON 字符串）
 */
function normalizeParamValue(paramValue, expectedType) {
  // 如果已经是期望的类型，直接返回
  if (typeof paramValue === expectedType) {
    return paramValue
  }
  
  // 如果期望类型是 object 或 array，且值是字符串，尝试解析 JSON
  if ((expectedType === 'object' || expectedType === 'array') && typeof paramValue === 'string') {
    const trimmed = paramValue.trim()
    if ((expectedType === 'object' && trimmed.startsWith('{')) || 
        (expectedType === 'array' && trimmed.startsWith('['))) {
      try {
        const parsed = JSON.parse(trimmed)
        if ((expectedType === 'object' && typeof parsed === 'object' && !Array.isArray(parsed)) ||
            (expectedType === 'array' && Array.isArray(parsed))) {
          return parsed
        }
      } catch (e) {
        // JSON 解析失败，返回原值
      }
    }
  }
  
  return paramValue
}

/**
 * 验证参数类型
 */
function validateParamType(paramValue, paramName, expectedType) {
  const errors = []
  
  // 先尝试规范化参数值（处理 JSON 字符串）
  const normalizedValue = normalizeParamValue(paramValue, expectedType)
  
  if (typeof normalizedValue !== expectedType) {
    errors.push(`参数 '${paramName}' 类型错误: 期望 ${expectedType}，收到 ${typeof paramValue}`)
  }
  
  return errors
}

/**
 * 验证数组参数
 * 返回：{ errors: [], normalizedValue: any } - normalizedValue 是规范化后的值
 */
function validateArrayParam(paramValue, paramName, minLength = 0) {
  const errors = []
  
  // 如果参数是 JSON 字符串，尝试解析
  let normalizedValue = paramValue
  if (typeof paramValue === 'string') {
    const trimmed = paramValue.trim()
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (Array.isArray(parsed)) {
          normalizedValue = parsed
        } else {
          // 解析成功但不是数组，尝试转换为数组
          normalizedValue = [parsed]
        }
      } catch (e) {
        // JSON 解析失败，尝试按逗号分割
        if (trimmed.includes(',')) {
          normalizedValue = trimmed.split(',').map(item => item.trim()).filter(item => item)
        } else {
          // 单个值，转换为单元素数组
          normalizedValue = trimmed ? [trimmed] : []
        }
      }
    } else if (trimmed.includes(',')) {
      // 逗号分隔的字符串，分割为数组
      normalizedValue = trimmed.split(',').map(item => item.trim()).filter(item => item)
    } else if (trimmed) {
      // 单个字符串值，转换为单元素数组
      normalizedValue = [trimmed]
    } else {
      normalizedValue = []
    }
  }
  
  if (!Array.isArray(normalizedValue)) {
    errors.push(`参数 '${paramName}' 必须是数组，收到: ${typeof paramValue}`)
    return { errors, normalizedValue: paramValue }
  }
  
  if (normalizedValue.length < minLength) {
    errors.push(`参数 '${paramName}' 数组长度不能小于 ${minLength}`)
  }
  
  return { errors, normalizedValue }
}

/**
 * 验证操作参数
 */
export function validateOperation(workbook, operation) {
  if (!operation || typeof operation !== 'object') {
    return {
      isValid: false,
      errors: ['操作对象无效']
    }
  }
  
  let { type, params } = operation
  const errors = []

  if (type && typeof type === 'string') {
    const nt = normalizeOperationType(type)
    if (nt !== type) {
      type = nt
      operation.type = nt
    }
  }

  if (!type || typeof type !== 'string') {
    errors.push('操作类型无效或缺失')
    return { isValid: false, errors }
  }
  
  if (!params || typeof params !== 'object') {
    errors.push('操作参数无效或缺失')
    return { isValid: false, errors }
  }
  
  // 根据操作类型进行验证
  switch (type) {
    case 'set_cell_value':
      errors.push(...validateRequiredParams(params, ['sheet', 'row', 'col', 'value']))
      if (errors.length === 0) {
        errors.push(...validateCellPosition(workbook, params.sheet, params.row, params.col))
      }
      break
    
    case 'set_cell_formula':
      errors.push(...validateRequiredParams(params, ['sheet', 'row', 'col', 'formula']))
      if (errors.length === 0) {
        errors.push(...validateCellPosition(workbook, params.sheet, params.row, params.col))
        if (typeof params.formula !== 'string' || params.formula.length === 0) {
          errors.push('公式必须是非空字符串')
        }
      }
      break
    
    case 'set_cell_style':
      errors.push(...validateRequiredParams(params, ['sheet', 'row', 'col', 'style']))
      if (errors.length === 0) {
        errors.push(...validateCellPosition(workbook, params.sheet, params.row, params.col))
        // 规范化 style 参数（处理 JSON 字符串）
        const normalizedStyle = normalizeParamValue(params.style, 'object')
        errors.push(...validateParamType(normalizedStyle, 'style', 'object'))
        // 如果规范化成功，更新 params 以便后续使用
        if (typeof normalizedStyle === 'object' && normalizedStyle !== params.style) {
          params.style = normalizedStyle
        }
      }
      break
    
    case 'set_range_values':
      errors.push(...validateRequiredParams(params, ['sheet', 'startRow', 'startCol', 'values']))
      if (errors.length === 0) {
        errors.push(...validateCellPosition(workbook, params.sheet, params.startRow, params.startCol))
        // validateArrayParam 返回规范化后的值
        const arrayResult = validateArrayParam(params.values, 'values')
        errors.push(...arrayResult.errors)
        // 如果验证通过，更新 params 中的值
        if (arrayResult.errors.length === 0 && Array.isArray(arrayResult.normalizedValue)) {
          params.values = arrayResult.normalizedValue
        }
      }
      break
    
    case 'set_range_style':
      errors.push(...validateRequiredParams(params, ['sheet', 'startRow', 'startCol', 'endRow', 'endCol', 'style']))
      if (errors.length === 0) {
        errors.push(...validateRange(
          workbook,
          params.sheet,
          params.startRow,
          params.startCol,
          params.endRow,
          params.endCol
        ))
        // 规范化 style 参数（处理 JSON 字符串）
        const normalizedStyle = normalizeParamValue(params.style, 'object')
        errors.push(...validateParamType(normalizedStyle, 'style', 'object'))
        // 如果规范化成功，更新 params 以便后续使用
        if (typeof normalizedStyle === 'object' && normalizedStyle !== params.style) {
          params.style = normalizedStyle
        }
      }
      break
    
    case 'merge_cells':
    case 'clear_range':
      errors.push(...validateRequiredParams(params, ['sheet', 'startRow', 'startCol', 'endRow', 'endCol']))
      if (errors.length === 0) {
        errors.push(...validateRange(
          workbook,
          params.sheet,
          params.startRow,
          params.startCol,
          params.endRow,
          params.endCol
        ))
      }
      break
    
    case 'insert_row':
    case 'delete_row':
      errors.push(...validateRequiredParams(params, ['sheet', 'row']))
      if (errors.length === 0) {
        errors.push(...validateSheetExists(workbook, params.sheet))
        errors.push(...validateRowNumber(params.row))
      }
      break
    
    case 'insert_column':
    case 'delete_column':
      errors.push(...validateRequiredParams(params, ['sheet', 'col']))
      if (errors.length === 0) {
        errors.push(...validateSheetExists(workbook, params.sheet))
        errors.push(...validateColNumber(params.col))
      }
      break
    
    case 'set_row_height':
      errors.push(...validateRequiredParams(params, ['sheet', 'row', 'height']))
      if (errors.length === 0) {
        errors.push(...validateSheetExists(workbook, params.sheet))
        errors.push(...validateRowNumber(params.row))
        const height = typeof params.height === 'number' ? params.height : parseFloat(params.height)
        if (isNaN(height) || height < 0) {
          errors.push(`行高必须是大于等于0的数字，收到: ${params.height}`)
        }
      }
      break
    
    case 'set_column_width':
      errors.push(...validateRequiredParams(params, ['sheet', 'col', 'width']))
      if (errors.length === 0) {
        errors.push(...validateSheetExists(workbook, params.sheet))
        errors.push(...validateColNumber(params.col))
        const width = typeof params.width === 'number' ? params.width : parseFloat(params.width)
        if (isNaN(width) || width < 0) {
          errors.push(`列宽必须是大于等于0的数字，收到: ${params.width}`)
        }
      }
      break
    
    case 'hide_row':
    case 'show_row':
      errors.push(...validateRequiredParams(params, ['sheet']))
      if (errors.length === 0) {
        errors.push(...validateSheetExists(workbook, params.sheet))
        const hasSingleRow = params.row !== undefined
        const hasRangeRow = params.startRow !== undefined && params.endRow !== undefined
        if (!hasSingleRow && !hasRangeRow) {
          errors.push('缺少必需参数: row 或 startRow/endRow')
          break
        }
        if (hasSingleRow) {
          errors.push(...validateRowNumber(params.row))
        } else {
          errors.push(...validateRowNumber(params.startRow))
          errors.push(...validateRowNumber(params.endRow))
          const startRowNum = typeof params.startRow === 'number' ? params.startRow : parseInt(params.startRow)
          const endRowNum = typeof params.endRow === 'number' ? params.endRow : parseInt(params.endRow)
          if (!isNaN(startRowNum) && !isNaN(endRowNum) && startRowNum > endRowNum) {
            errors.push('起始行号不能大于结束行号')
          }
        }
      }
      break
    
    case 'hide_column':
    case 'show_column':
      errors.push(...validateRequiredParams(params, ['sheet']))
      if (errors.length === 0) {
        errors.push(...validateSheetExists(workbook, params.sheet))
        const hasSingleCol = params.col !== undefined
        const hasRangeCol = params.startCol !== undefined && params.endCol !== undefined
        if (!hasSingleCol && !hasRangeCol) {
          errors.push('缺少必需参数: col 或 startCol/endCol')
          break
        }
        if (hasSingleCol) {
          errors.push(...validateColNumber(params.col))
        } else {
          errors.push(...validateColNumber(params.startCol))
          errors.push(...validateColNumber(params.endCol))
          const startColNum = typeof params.startCol === 'number' ? params.startCol : parseInt(params.startCol)
          const endColNum = typeof params.endCol === 'number' ? params.endCol : parseInt(params.endCol)
          if (!isNaN(startColNum) && !isNaN(endColNum) && startColNum > endColNum) {
            errors.push('起始列号不能大于结束列号')
          }
        }
      }
      break
    
    case 'add_sheet':
      errors.push(...validateRequiredParams(params, ['name']))
      if (errors.length === 0) {
        if (typeof params.name !== 'string' || params.name.length === 0) {
          errors.push('工作表名称必须是非空字符串')
        } else if (params.name.length > 31) {
          errors.push('工作表名称长度不能超过31个字符')
        }
      }
      break
    
    case 'rename_sheet':
      errors.push(...validateRequiredParams(params, ['oldName', 'newName']))
      if (errors.length === 0) {
        errors.push(...validateSheetExists(workbook, params.oldName))
        if (typeof params.newName !== 'string' || params.newName.length === 0) {
          errors.push('新工作表名称必须是非空字符串')
        } else if (params.newName.length > 31) {
          errors.push('新工作表名称长度不能超过31个字符')
        }
      }
      break
    
    case 'set_active_sheet':
      errors.push(...validateRequiredParams(params, ['name']))
      if (errors.length === 0) {
        errors.push(...validateSheetExists(workbook, params.name))
      }
      break
    
    case 'sort_range':
      errors.push(...validateRequiredParams(params, ['sheet', 'startRow', 'startCol', 'endRow', 'endCol']))
      if (errors.length === 0) {
        errors.push(...validateRange(
          workbook,
          params.sheet,
          params.startRow,
          params.startCol,
          params.endRow,
          params.endCol
        ))
        
        // 验证 sortColumns 参数（容错处理）
        if (!params.sortColumns || !Array.isArray(params.sortColumns) || params.sortColumns.length === 0) {
          // 如果缺失或无效，使用默认值：按第一列升序排序
          console.warn('sort_range: sortColumns 参数缺失或无效，使用默认值（按第一列升序）')
          params.sortColumns = [{
            column: params.startCol || 1,
            order: 'asc'
          }]
        } else {
          // 验证每个元素
          const sortColErrors = []
          for (let i = 0; i < params.sortColumns.length; i++) {
            const item = params.sortColumns[i]
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
              sortColErrors.push(`sortColumns[${i}] 必须是对象`)
            } else {
              const col = item.column || item.columnIndex || item.col
              if (col === undefined || col === null) {
                sortColErrors.push(`sortColumns[${i}] 缺少 column 字段`)
              } else {
                const colNum = typeof col === 'number' ? col : parseInt(col)
                if (isNaN(colNum) || colNum < 1) {
                  sortColErrors.push(`sortColumns[${i}].column 必须是大于0的数字，收到: ${col}`)
                }
              }
              const order = item.order || 'asc'
              if (order !== 'asc' && order !== 'desc' && order !== 'ascending' && order !== 'descending') {
                sortColErrors.push(`sortColumns[${i}].order 必须是 'asc' 或 'desc'，收到: ${order}`)
              }
            }
          }
          if (sortColErrors.length > 0) {
            // 如果验证失败，使用默认值而不是报错（容错处理）
            console.warn('sort_range: sortColumns 验证失败，使用默认值', sortColErrors)
            params.sortColumns = [{
              column: params.startCol || 1,
              order: 'asc'
            }]
          }
        }
        
        // 容错处理：确保 hasHeader 有默认值
        if (params.hasHeader === undefined || params.hasHeader === null) {
          params.hasHeader = true
        }
      }
      break
    
    case 'create_chart':
      errors.push(...validateRequiredParams(params, ['sheet', 'row', 'col', 'chartType', 'dataRange']))
      if (errors.length === 0) {
        errors.push(...validateSheetExists(workbook, params.sheet))
        errors.push(...validateCellPosition(workbook, params.sheet, params.row, params.col))
        const chartType = String(params.chartType || '').toLowerCase()
        const validChartTypes = ['column', 'line', 'pie', 'bar', 'area', 'scatter', 'doughnut', 'donut']
        if (!validChartTypes.includes(chartType)) {
          errors.push(`chartType 无效，必须是 ${validChartTypes.join(', ')} 之一`)
        }
        if (!params.dataRange || (typeof params.dataRange !== 'string' && typeof params.dataRange !== 'object')) {
          errors.push('dataRange 参数不能为空且必须是字符串或对象')
        } else if (typeof params.dataRange === 'string') {
          if (!params.dataRange.includes(':')) {
            errors.push('dataRange 字符串格式无效，必须是 A1:B10 形式')
          }
        } else {
          const r = params.dataRange
          const nestedShape = r.start && r.end && typeof r.start === 'object' && typeof r.end === 'object'
          const flatShape = ['startRow', 'startCol', 'endRow', 'endCol'].every((k) => r[k] !== undefined)
          if (!nestedShape && !flatShape) {
            errors.push('dataRange 对象格式无效，必须包含 start/end 或 startRow/startCol/endRow/endCol')
          }
        }
      }
      break
    
    case 'create_pivot_table':
      errors.push(...validateRequiredParams(params, ['sheet', 'sourceRange', 'rowFields', 'valueFields']))
      if (errors.length === 0) {
        errors.push(...validateSheetExists(workbook, params.sheet))
        
        // 规范化并验证 rowFields（validateArrayParam 会返回规范化后的值）
        const rowFieldsResult = validateArrayParam(params.rowFields, 'rowFields', 1)
        errors.push(...rowFieldsResult.errors)
        if (rowFieldsResult.errors.length === 0 && Array.isArray(rowFieldsResult.normalizedValue)) {
          params.rowFields = rowFieldsResult.normalizedValue
        }
        
        // 规范化并验证 valueFields
        const valueFieldsResult = validateArrayParam(params.valueFields, 'valueFields', 1)
        errors.push(...valueFieldsResult.errors)
        if (valueFieldsResult.errors.length === 0 && Array.isArray(valueFieldsResult.normalizedValue)) {
          params.valueFields = valueFieldsResult.normalizedValue
        }
        
        // 规范化 colFields（可选参数）
        if (params.colFields !== undefined && params.colFields !== null) {
          const colFieldsResult = validateArrayParam(params.colFields, 'colFields', 0)
          // colFields 是可选的，所以即使验证失败也不添加错误
          if (colFieldsResult.errors.length === 0 && Array.isArray(colFieldsResult.normalizedValue)) {
            params.colFields = colFieldsResult.normalizedValue
          }
        }
      }
      break
    
    case 'filter_data':
      errors.push(...validateRequiredParams(params, ['sheet', 'startRow', 'startCol', 'endRow', 'endCol', 'conditions']))
      if (errors.length === 0) {
        errors.push(...validateRange(workbook, params.sheet, params.startRow, params.startCol, params.endRow, params.endCol))
        // 验证 conditions 参数结构
        const conditions = params.conditions
        if (!conditions || typeof conditions !== 'object') {
          errors.push('conditions 必须是对象或数组')
        } else if (Array.isArray(conditions)) {
          // 兼容旧格式：[{ column/col, operator, value }]
          if (conditions.length === 0) {
            console.warn('filter_data: conditions 为空数组')
          } else {
            for (let i = 0; i < conditions.length; i++) {
              const cond = conditions[i]
              if (!cond || typeof cond !== 'object') {
                errors.push(`conditions[${i}] 必须是对象`)
              }
            }
          }
        } else if (Object.keys(conditions).length === 0) {
          // 容错处理：空 conditions 警告但不报错
          console.warn('filter_data: conditions 为空')
        } else {
          for (const [colKey, condition] of Object.entries(conditions)) {
            if (!condition || typeof condition !== 'object') {
              errors.push(`conditions['${colKey}'] 必须是对象`)
            }
          }
        }
      }
      break
    
    case 'remove_duplicates':
      errors.push(...validateRequiredParams(params, ['sheet', 'startRow', 'startCol', 'endRow', 'endCol']))
      if (errors.length === 0) {
        errors.push(...validateRange(workbook, params.sheet, params.startRow, params.startCol, params.endRow, params.endCol))
        // 验证 columns 参数（可选）
        if (params.columns !== undefined && params.columns !== null) {
          if (!Array.isArray(params.columns)) {
            // 容错：尝试转换为数组
            if (typeof params.columns === 'string') {
              try {
                params.columns = JSON.parse(params.columns)
              } catch (e) {
                params.columns = [params.columns]
              }
            } else {
              params.columns = [params.columns]
            }
          }
          if (params.columns.length === 0) {
            console.warn('remove_duplicates: columns 为空，将使用所有列')
          }
        }
        // 容错：hasHeader 默认值
        if (params.hasHeader === undefined || params.hasHeader === null) {
          params.hasHeader = true
        }
      }
      break
    
    case 'conditional_format':
      // 兼容两套协议：
      // 新协议：condition + format
      // 旧协议：ruleType + ruleParams + formatStyle
      if ((!params.condition || typeof params.condition !== 'object') && params.ruleType) {
        const condition = { type: params.ruleType }
        if (params.ruleParams && typeof params.ruleParams === 'object') {
          Object.assign(condition, params.ruleParams)
        }
        params.condition = condition
      }
      if ((!params.format || typeof params.format !== 'object') && params.formatStyle && typeof params.formatStyle === 'object') {
        params.format = params.formatStyle
      }

      errors.push(...validateRequiredParams(params, ['sheet', 'startRow', 'startCol', 'endRow', 'endCol']))
      if (errors.length === 0) {
        errors.push(...validateRange(workbook, params.sheet, params.startRow, params.startCol, params.endRow, params.endCol))
        // 兼容旧参数：ruleParams（可选）
        if (params.ruleParams !== undefined && params.ruleParams !== null) {
          if (typeof params.ruleParams === 'string') {
            try {
              params.ruleParams = JSON.parse(params.ruleParams)
            } catch (e) {
              console.warn('conditional_format: ruleParams JSON 解析失败')
            }
          }
          if (params.ruleParams && typeof params.ruleParams !== 'object') {
            errors.push('ruleParams 必须是对象')
          }
        }
        // 验证 formatStyle（可选）
        if (params.formatStyle !== undefined && params.formatStyle !== null) {
          if (typeof params.formatStyle === 'string') {
            try {
              params.formatStyle = JSON.parse(params.formatStyle)
            } catch (e) {
              console.warn('conditional_format: formatStyle JSON 解析失败')
            }
          }
          if (params.formatStyle && typeof params.formatStyle !== 'object') {
            errors.push('formatStyle 必须是对象')
          }
        }

        // 新协议校验：condition
        if (params.condition === undefined || params.condition === null) {
          errors.push('缺少必需参数: condition 或 ruleType')
        } else if (typeof params.condition !== 'object') {
          errors.push('condition 必须是对象')
        } else if (!params.condition.type && !params.ruleType) {
          errors.push('condition.type 不能为空')
        }

        // 新协议校验：format（可选）
        if (params.format !== undefined && params.format !== null && typeof params.format !== 'object') {
          errors.push('format 必须是对象')
        }
      }
      break
    
    case 'set_data_validation':
      // 兼容旧参数：validation = { type, ... } -> 标准化为 validationType + validationParams
      if ((!params.validationType || params.validationType === '') && params.validation && typeof params.validation === 'object') {
        const validationObj = params.validation
        params.validationType = validationObj.type || validationObj.validationType
        params.validationParams =
          validationObj.params ||
          validationObj.validationParams ||
          Object.fromEntries(Object.entries(validationObj).filter(([k]) => k !== 'type' && k !== 'validationType'))
      }

      errors.push(...validateRequiredParams(params, ['sheet', 'startRow', 'startCol', 'endRow', 'endCol', 'validationType']))
      if (errors.length === 0) {
        errors.push(...validateRange(workbook, params.sheet, params.startRow, params.startCol, params.endRow, params.endCol))
        // 验证 validationType
        const validTypes = ['list', 'whole', 'decimal', 'date', 'time', 'textLength', 'custom']
        if (!validTypes.includes(params.validationType)) {
          console.warn(`set_data_validation: validationType '${params.validationType}' 不在预定义列表中`)
        }
        // 验证 validationParams
        if (params.validationParams === undefined || params.validationParams === null) {
          errors.push('validationParams 参数不能为空')
        } else {
          if (typeof params.validationParams === 'string') {
            try {
              params.validationParams = JSON.parse(params.validationParams)
            } catch (e) {
              errors.push('validationParams JSON 解析失败')
            }
          }
          if (params.validationParams && typeof params.validationParams !== 'object') {
            errors.push('validationParams 必须是对象')
          }
        }
      }
      break
    
    case 'fill_series':
      errors.push(...validateRequiredParams(params, ['sheet', 'startRow', 'startCol', 'endRow', 'endCol']))
      if (errors.length === 0) {
        errors.push(...validateRange(workbook, params.sheet, params.startRow, params.startCol, params.endRow, params.endCol))
        // 容错：direction 默认值
        const validDirections = ['down', 'up', 'right', 'left']
        if (!params.direction) {
          params.direction = 'down'
        } else if (!validDirections.includes(params.direction)) {
          console.warn(`fill_series: direction '${params.direction}' 无效，使用默认值 'down'`)
          params.direction = 'down'
        }
        // 容错：seriesType 默认值
        const validSeriesTypes = ['linear', 'growth', 'date', 'autofill']
        if (!params.seriesType) {
          params.seriesType = 'linear'
        } else if (!validSeriesTypes.includes(params.seriesType)) {
          console.warn(`fill_series: seriesType '${params.seriesType}' 无效，使用默认值 'linear'`)
          params.seriesType = 'linear'
        }
        // 容错：step 默认值
        if (params.step === undefined || params.step === null) {
          params.step = 1
        } else if (typeof params.step !== 'number') {
          const numStep = parseFloat(params.step)
          params.step = isNaN(numStep) ? 1 : numStep
        }
      }
      break
    
    case 'batch_operations':
      if (!params.operations) {
        errors.push('operations 参数不能为空')
      } else {
        // 容错：解析 JSON 字符串
        if (typeof params.operations === 'string') {
          try {
            params.operations = JSON.parse(params.operations)
          } catch (e) {
            errors.push('operations JSON 解析失败')
          }
        }
        if (params.operations && !Array.isArray(params.operations)) {
          errors.push('operations 必须是数组')
        } else if (params.operations && params.operations.length === 0) {
          errors.push('operations 数组不能为空')
        } else if (params.operations) {
          // 递归验证每个子操作
          for (let i = 0; i < params.operations.length; i++) {
            const op = params.operations[i]
            if (!op || typeof op !== 'object') {
              errors.push(`operations[${i}] 必须是对象`)
            } else if (!op.type) {
              errors.push(`operations[${i}] 缺少 type 字段`)
            } else if (!op.params) {
              errors.push(`operations[${i}] 缺少 params 字段`)
            } else {
              // 递归验证（简化版，只验证基本结构）
              const subValidation = validateOperation(workbook, op)
              if (!subValidation.isValid) {
                for (const err of subValidation.errors) {
                  errors.push(`operations[${i}].${err}`)
                }
              }
            }
          }
        }
      }
      break
    
    case 'create_pivot_data':
      errors.push(...validateRequiredParams(params, ['sheet', 'startRow', 'startCol', 'endRow', 'endCol', 'rowFields', 'valueField']))
      if (errors.length === 0) {
        errors.push(...validateRange(workbook, params.sheet, params.startRow, params.startCol, params.endRow, params.endCol))
        // 验证 rowFields
        const rowFieldsResult = validateArrayParam(params.rowFields, 'rowFields', 1)
        errors.push(...rowFieldsResult.errors)
        if (rowFieldsResult.errors.length === 0 && Array.isArray(rowFieldsResult.normalizedValue)) {
          params.rowFields = rowFieldsResult.normalizedValue
        }
        // 验证 colFields（可选）
        if (params.colFields !== undefined && params.colFields !== null) {
          const colFieldsResult = validateArrayParam(params.colFields, 'colFields', 0)
          if (colFieldsResult.errors.length === 0 && Array.isArray(colFieldsResult.normalizedValue)) {
            params.colFields = colFieldsResult.normalizedValue
          }
        }
        // 验证 valueField
        if (params.valueField === undefined || params.valueField === null) {
          errors.push('valueField 参数不能为空')
        }
        // 容错：aggregateFunction 默认值
        const validAggFuncs = ['sum', 'count', 'average', 'max', 'min', 'product', 'stdev', 'var']
        if (!params.aggregateFunction) {
          params.aggregateFunction = 'sum'
        } else if (!validAggFuncs.includes(params.aggregateFunction)) {
          console.warn(`create_pivot_data: aggregateFunction '${params.aggregateFunction}' 无效，使用默认值 'sum'`)
          params.aggregateFunction = 'sum'
        }
      }
      break
    
    case 'update_chart':
      errors.push(...validateRequiredParams(params, ['sheet', 'chartId']))
      if (errors.length === 0) {
        errors.push(...validateSheetExists(workbook, params.sheet))
        // 验证 chartId
        if (!params.chartId || typeof params.chartId !== 'string') {
          errors.push('chartId 必须是非空字符串')
        }
        // 验证 dataRange（可选）
        if (params.dataRange !== undefined && params.dataRange !== null) {
          if (typeof params.dataRange !== 'string' && typeof params.dataRange !== 'object') {
            errors.push('dataRange 必须是字符串或对象')
          }
        }
        // 验证 style（可选）
        if (params.style !== undefined && params.style !== null) {
          if (typeof params.style === 'string') {
            try {
              params.style = JSON.parse(params.style)
            } catch (e) {
              console.warn('update_chart: style JSON 解析失败')
            }
          }
          if (params.style && typeof params.style !== 'object') {
            errors.push('style 必须是对象')
          }
        }
      }
      break
    
    case 'update_pivot_table':
      errors.push(...validateRequiredParams(params, ['sheet', 'pivotTableId']))
      if (errors.length === 0) {
        errors.push(...validateSheetExists(workbook, params.sheet))
        // 验证 pivotTableId
        if (!params.pivotTableId || typeof params.pivotTableId !== 'string') {
          errors.push('pivotTableId 必须是非空字符串')
        }
        // 验证 rowFields（可选）
        if (params.rowFields !== undefined && params.rowFields !== null) {
          const rowFieldsResult = validateArrayParam(params.rowFields, 'rowFields', 0)
          if (rowFieldsResult.errors.length === 0 && Array.isArray(rowFieldsResult.normalizedValue)) {
            params.rowFields = rowFieldsResult.normalizedValue
          }
        }
        // 验证 colFields（可选）
        if (params.colFields !== undefined && params.colFields !== null) {
          const colFieldsResult = validateArrayParam(params.colFields, 'colFields', 0)
          if (colFieldsResult.errors.length === 0 && Array.isArray(colFieldsResult.normalizedValue)) {
            params.colFields = colFieldsResult.normalizedValue
          }
        }
        // 验证 valueFields（可选）
        if (params.valueFields !== undefined && params.valueFields !== null) {
          const valueFieldsResult = validateArrayParam(params.valueFields, 'valueFields', 0)
          if (valueFieldsResult.errors.length === 0 && Array.isArray(valueFieldsResult.normalizedValue)) {
            params.valueFields = valueFieldsResult.normalizedValue
          }
        }
      }
      break
    
    // ============ 中等风险工具验证 ============
    
    case 'clear_cell':
      errors.push(...validateRequiredParams(params, ['sheet', 'row', 'col']))
      if (errors.length === 0) {
        errors.push(...validateCellPosition(workbook, params.sheet, params.row, params.col))
      }
      break
    
    case 'unmerge_cells':
      errors.push(...validateRequiredParams(params, ['sheet', 'startRow', 'startCol', 'endRow', 'endCol']))
      if (errors.length === 0) {
        errors.push(...validateRange(workbook, params.sheet, params.startRow, params.startCol, params.endRow, params.endCol))
      }
      break
    
    case 'copy_sheet':
      errors.push(...validateRequiredParams(params, ['sourceName', 'newName']))
      if (errors.length === 0) {
        errors.push(...validateSheetExists(workbook, params.sourceName))
        if (!params.newName || typeof params.newName !== 'string' || params.newName.length > 31) {
          errors.push('newName 必须是非空字符串，且长度不超过31')
        }
      }
      break
    
    case 'remove_filter':
      errors.push(...validateRequiredParams(params, ['sheet']))
      if (errors.length === 0) {
        errors.push(...validateSheetExists(workbook, params.sheet))
      }
      break
    
    case 'find_replace':
      errors.push(...validateRequiredParams(params, ['sheet', 'find', 'replace']))
      if (errors.length === 0) {
        errors.push(...validateSheetExists(workbook, params.sheet))
        if (typeof params.find !== 'string') {
          errors.push('find 必须是字符串')
        }
        if (typeof params.replace !== 'string') {
          errors.push('replace 必须是字符串')
        }
      }
      break
    
    case 'copy_paste':
      errors.push(...validateRequiredParams(params, ['sheet', 'sourceStartRow', 'sourceStartCol', 
                                                     'sourceEndRow', 'sourceEndCol', 'targetRow', 'targetCol']))
      if (errors.length === 0) {
        errors.push(...validateSheetExists(workbook, params.sheet))
        errors.push(...validateRange(workbook, params.sheet, params.sourceStartRow, params.sourceStartCol,
                                     params.sourceEndRow, params.sourceEndCol))
        errors.push(...validateRowNumber(params.targetRow))
        errors.push(...validateColNumber(params.targetCol))
      }
      break
    
    case 'clear_formatting':
    case 'clear_conditional_format':
      errors.push(...validateRequiredParams(params, ['sheet', 'startRow', 'startCol', 'endRow', 'endCol']))
      if (errors.length === 0) {
        errors.push(...validateRange(workbook, params.sheet, params.startRow, params.startCol, params.endRow, params.endCol))
      }
      break
    
    case 'calculate_statistics':
      errors.push(...validateRequiredParams(params, ['sheet', 'startRow', 'startCol', 'endRow', 'endCol']))
      if (errors.length === 0) {
        errors.push(...validateRange(workbook, params.sheet, params.startRow, params.startCol, params.endRow, params.endCol))
      }
      break
    
    case 'summarize_by_column':
      errors.push(...validateRequiredParams(params, ['sheet', 'startRow', 'endRow', 'groupByCol', 'sumCol']))
      if (errors.length === 0) {
        errors.push(...validateSheetExists(workbook, params.sheet))
        errors.push(...validateRowNumber(params.startRow))
        errors.push(...validateRowNumber(params.endRow))
        errors.push(...validateColNumber(params.groupByCol))
        errors.push(...validateColNumber(params.sumCol))
      }
      break
    
    case 'summarize_metrics_by_column':
      errors.push(...validateRequiredParams(params, ['sheet', 'startRow', 'endRow', 'groupByCol', 'sumCol']))
      if (errors.length === 0) {
        errors.push(...validateSheetExists(workbook, params.sheet))
        errors.push(...validateRowNumber(params.startRow))
        errors.push(...validateRowNumber(params.endRow))
        errors.push(...validateColNumber(params.groupByCol))
        errors.push(...validateColNumber(params.sumCol))
      }
      break
    
    case 'remove_data_validation':
      errors.push(...validateRequiredParams(params, ['sheet', 'startRow', 'startCol', 'endRow', 'endCol']))
      if (errors.length === 0) {
        errors.push(...validateRange(workbook, params.sheet, params.startRow, params.startCol, params.endRow, params.endCol))
      }
      break
    
    case 'add_comment':
      errors.push(...validateRequiredParams(params, ['sheet', 'row', 'col', 'comment']))
      if (errors.length === 0) {
        errors.push(...validateCellPosition(workbook, params.sheet, params.row, params.col))
        if (typeof params.comment !== 'string') {
          errors.push('comment 必须是字符串')
        }
      }
      break
    
    case 'delete_comment':
      errors.push(...validateRequiredParams(params, ['sheet', 'row', 'col']))
      if (errors.length === 0) {
        errors.push(...validateCellPosition(workbook, params.sheet, params.row, params.col))
      }
      break
    
    case 'update_comment':
      errors.push(...validateRequiredParams(params, ['sheet', 'row', 'col', 'comment']))
      if (errors.length === 0) {
        errors.push(...validateCellPosition(workbook, params.sheet, params.row, params.col))
        if (typeof params.comment !== 'string') {
          errors.push('comment 必须是字符串')
        }
      }
      break
    
    case 'set_hyperlink':
      errors.push(...validateRequiredParams(params, ['sheet', 'row', 'col', 'url']))
      if (errors.length === 0) {
        errors.push(...validateCellPosition(workbook, params.sheet, params.row, params.col))
        if (!params.url || typeof params.url !== 'string') {
          errors.push('url 必须是非空字符串')
        }
      }
      break
    
    case 'remove_hyperlink':
      errors.push(...validateRequiredParams(params, ['sheet', 'row', 'col']))
      if (errors.length === 0) {
        errors.push(...validateCellPosition(workbook, params.sheet, params.row, params.col))
      }
      break
    
    case 'insert_image':
      errors.push(...validateRequiredParams(params, ['sheet', 'row', 'col', 'imageUrl']))
      if (errors.length === 0) {
        errors.push(...validateCellPosition(workbook, params.sheet, params.row, params.col))
        if (!params.imageUrl || typeof params.imageUrl !== 'string') {
          errors.push('imageUrl 必须是非空字符串')
        }
      }
      break
    
    case 'delete_image':
      errors.push(...validateRequiredParams(params, ['sheet', 'imageId']))
      if (errors.length === 0) {
        errors.push(...validateSheetExists(workbook, params.sheet))
        if (!params.imageId || typeof params.imageId !== 'string') {
          errors.push('imageId 必须是非空字符串')
        }
      }
      break
    
    case 'update_image':
      errors.push(...validateRequiredParams(params, ['sheet', 'imageId']))
      if (errors.length === 0) {
        errors.push(...validateSheetExists(workbook, params.sheet))
        if (!params.imageId || typeof params.imageId !== 'string') {
          errors.push('imageId 必须是非空字符串')
        }
      }
      break
    
    case 'insert_shape':
      errors.push(...validateRequiredParams(params, ['sheet', 'shapeType', 'row', 'col']))
      if (errors.length === 0) {
        errors.push(...validateCellPosition(workbook, params.sheet, params.row, params.col))
        if (!params.shapeType || typeof params.shapeType !== 'string') {
          errors.push('shapeType 必须是非空字符串')
        }
      }
      break
    
    case 'delete_shape':
      errors.push(...validateRequiredParams(params, ['sheet', 'shapeId']))
      if (errors.length === 0) {
        errors.push(...validateSheetExists(workbook, params.sheet))
        if (!params.shapeId || typeof params.shapeId !== 'string') {
          errors.push('shapeId 必须是非空字符串')
        }
      }
      break
    
    case 'update_shape':
      errors.push(...validateRequiredParams(params, ['sheet', 'shapeId']))
      if (errors.length === 0) {
        errors.push(...validateSheetExists(workbook, params.sheet))
        if (!params.shapeId || typeof params.shapeId !== 'string') {
          errors.push('shapeId 必须是非空字符串')
        }
      }
      break
    
    case 'delete_chart':
      errors.push(...validateRequiredParams(params, ['sheet', 'chartId']))
      if (errors.length === 0) {
        errors.push(...validateSheetExists(workbook, params.sheet))
        if (!params.chartId || typeof params.chartId !== 'string') {
          errors.push('chartId 必须是非空字符串')
        }
      }
      break
    
    case 'delete_pivot_table':
      errors.push(...validateRequiredParams(params, ['sheet', 'pivotTableId']))
      if (errors.length === 0) {
        errors.push(...validateSheetExists(workbook, params.sheet))
        if (!params.pivotTableId || typeof params.pivotTableId !== 'string') {
          errors.push('pivotTableId 必须是非空字符串')
        }
      }
      break
    
    case 'query_unique_values':
      errors.push(...validateRequiredParams(params, ['sheet', 'column']))
      if (errors.length === 0) {
        errors.push(...validateSheetExists(workbook, params.sheet))
        errors.push(...validateColNumber(params.column))
      }
      break

    case 'apply_custom_formula':
      errors.push(...validateRequiredParams(params, ['sheet', 'targetCol', 'startRow', 'endRow', 'expression']))
      if (errors.length === 0) {
        errors.push(...validateSheetExists(workbook, params.sheet))
      }
      break
    
    case 'auto_fit_column':
      errors.push(...validateRequiredParams(params, ['sheet', 'col']))
      if (errors.length === 0) {
        errors.push(...validateSheetExists(workbook, params.sheet))
        errors.push(...validateColNumber(params.col))
      }
      break
    
    default: {
      // 注册表门控：已注册但没有专用验证分支 -> 通用必填参数校验
      if (isKnownOperation(type)) {
        const required = getRequiredParams(type)
        if (required) {
          errors.push(...validateRequiredParams(params, required))
          if (errors.length === 0 && params.sheet) {
            errors.push(...validateSheetExists(workbook, params.sheet))
          }
        }
      } else {
        errors.push(`未知操作类型: ${type}`)
      }
      break
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors
  }
}
