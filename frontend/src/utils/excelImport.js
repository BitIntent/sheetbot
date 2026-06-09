// frontend/src/utils/excelImport.js
/**
 * Excel 导入工具
 * - 解析 ExcelJS 工作簿为前端 workbook 结构
 */

// ── ExcelJS Date 对象防误转工具 ──

/**
 * 判断 numFmt 是否为日期/时间格式。
 * 去除引号字面量和方括号条件后，检查是否含 y/d/h/s 等日期时间标记。
 */
function _isDateNumFmt(fmt) {
  if (!fmt || fmt === 'General') return false
  const cleaned = fmt.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '')
  return /[ydhsYDHS]/.test(cleaned)
}

/**
 * 将 JavaScript Date 还原为 Excel 序列号（数值）。
 * Excel 序列号 1 = 1900-01-01；存在 1900-02-29 闰年缺陷需补偿。
 */
function _jsDateToExcelSerial(d) {
  const epoch = Date.UTC(1899, 11, 31)
  let serial = (d.getTime() - epoch) / 86400000
  if (serial >= 60) serial += 1
  return Math.round(serial * 1e10) / 1e10
}

function normalizeArgbToHex(argb) {
  if (!argb) return undefined
  const raw = String(argb).trim()
  if (raw.length === 8) return `#${raw.slice(2)}`
  if (raw.length === 6) return `#${raw}`
  return undefined
}

function extractWorksheetTabColor(ws) {
  const argb = ws?.properties?.tabColor?.argb
  const hex = normalizeArgbToHex(argb)
  return hex || ''
}

function bytesToBase64(bytes) {
  if (!bytes) return ''
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < arr.length; i += chunkSize) {
    const chunk = arr.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

function buildExcelImageSrc(image) {
  if (!image) return ''
  const extension = String(image.extension || 'png').toLowerCase()
  const mime = extension === 'jpg' ? 'jpeg' : extension
  if (typeof image.base64 === 'string' && image.base64.trim()) {
    const base = image.base64.trim()
    if (base.startsWith('data:image/')) return base
    return `data:image/${mime};base64,${base}`
  }
  if (image.buffer) {
    const base64 = bytesToBase64(image.buffer)
    if (base64) return `data:image/${mime};base64,${base64}`
  }
  return ''
}

function extractWorksheetImages(ws, excelWb) {
  if (!ws || !excelWb) {
    return []
  }

  const refsFromApi = (typeof ws.getImages === 'function' ? ws.getImages() : null) || []
  const refsFromModel = Array.isArray(ws?.model?.media)
    ? ws.model.media
        .filter(item => item?.type === 'image')
        .map(item => ({ imageId: item.imageId, range: item.range }))
    : []
  const refs = refsFromApi.length > 0 ? refsFromApi : refsFromModel
  if (!Array.isArray(refs) || refs.length === 0) return []

  const getImageById = (imageId) => {
    if (typeof excelWb.getImage === 'function') {
      const direct = excelWb.getImage(imageId)
      if (direct) return direct
    }
    const media = Array.isArray(excelWb?.model?.media) ? excelWb.model.media : []
    return media.find((m) => Number(m?.index) === Number(imageId)) || null
  }

  const getAnchorNumber = (anchor, primaryKey, nativeKey) => {
    const v1 = Number(anchor?.[primaryKey])
    if (Number.isFinite(v1)) return v1
    const v2 = Number(anchor?.[nativeKey])
    if (Number.isFinite(v2)) return v2
    return NaN
  }

  const images = []
  refs.forEach((ref) => {
    try {
      const rawImage = getImageById(ref.imageId)
      const src = buildExcelImageSrc(rawImage)
      if (!src) return
      const tl = ref?.range?.tl || {}
      const br = ref?.range?.br || {}
      const ext = ref?.range?.ext || {}
      const tlRow = getAnchorNumber(tl, 'row', 'nativeRow')
      const tlCol = getAnchorNumber(tl, 'col', 'nativeCol')
      const brRow = getAnchorNumber(br, 'row', 'nativeRow')
      const brCol = getAnchorNumber(br, 'col', 'nativeCol')
      const row = Number.isFinite(tlRow) ? Math.max(1, Math.floor(tlRow) + 1) : 1
      const col = Number.isFinite(tlCol) ? Math.max(1, Math.floor(tlCol) + 1) : 1
      const rowSpan = Number.isFinite(brRow) && Number.isFinite(tlRow)
        ? Math.max(1, Math.round(brRow - tlRow))
        : 1
      const colSpan = Number.isFinite(brCol) && Number.isFinite(tlCol)
        ? Math.max(1, Math.round(brCol - tlCol))
        : 1
      images.push({
        row,
        col,
        rowSpan,
        colSpan,
        width: Number.isFinite(Number(ext.width)) ? Number(ext.width) : undefined,
        height: Number.isFinite(Number(ext.height)) ? Number(ext.height) : undefined,
        src,
      })
    } catch {
      // ignore broken image entries
    }
  })
  return images
}

function extractCellStyle(cell) {
  if (!cell) return undefined
  const style = {}

  if (cell.font) {
    if (cell.font.bold !== undefined) style.bold = !!cell.font.bold
    if (cell.font.italic !== undefined) style.italic = !!cell.font.italic
    if (cell.font.underline !== undefined) style.underline = !!cell.font.underline
    if (cell.font.strike !== undefined) style.strikethrough = !!cell.font.strike
    if (cell.font.size !== undefined) style.fontSize = cell.font.size
    const fontRgb = cell.font.color?.argb || cell.font.color?.rgb
    const fontColor = normalizeArgbToHex(fontRgb)
    if (fontColor) style.fontColor = fontColor
  }

  const fillRgb = cell.fill?.fgColor?.argb || cell.fill?.fgColor?.rgb
  const backgroundColor = normalizeArgbToHex(fillRgb)
  if (backgroundColor) style.backgroundColor = backgroundColor

  if (cell.alignment) {
    if (cell.alignment.horizontal) {
      style.horizontalAlignment = cell.alignment.horizontal
      style.horizontalAlign = cell.alignment.horizontal
    }
    if (cell.alignment.vertical) {
      style.verticalAlignment = cell.alignment.vertical
      style.verticalAlign = cell.alignment.vertical
    }
    if (cell.alignment.wrapText !== undefined) style.wrapText = !!cell.alignment.wrapText
  }

  if (cell.numFmt) style.numberFormat = cell.numFmt
  if (cell.border && Object.keys(cell.border).length > 0) {
    const normalizeBorderSide = (side) => {
      if (!side || typeof side !== 'object') return undefined
      const color = normalizeArgbToHex(side.color?.argb || side.color?.rgb)
      return {
        ...side,
        color: color || side.color
      }
    }
    style.border = {
      top: normalizeBorderSide(cell.border.top),
      right: normalizeBorderSide(cell.border.right),
      bottom: normalizeBorderSide(cell.border.bottom),
      left: normalizeBorderSide(cell.border.left)
    }
  }

  return Object.keys(style).length > 0 ? style : undefined
}

function colLettersToIndex(letters) {
  const text = String(letters || '').toUpperCase()
  let col = 0
  for (let i = 0; i < text.length; i++) {
    col = col * 26 + (text.charCodeAt(i) - 64)
  }
  return col
}

function parseA1Address(address) {
  const match = String(address || '').toUpperCase().match(/^([A-Z]+)(\d+)$/)
  if (!match) return null
  return {
    row: Number(match[2]),
    col: colLettersToIndex(match[1])
  }
}

function parseSqrefToRanges(sqref) {
  const refs = String(sqref || '').trim().split(/\s+/).filter(Boolean)
  const ranges = []
  refs.forEach(ref => {
    const parts = ref.split(':')
    const start = parseA1Address(parts[0])
    const end = parseA1Address(parts[1] || parts[0])
    if (!start || !end) return
    ranges.push({
      startRow: Math.min(start.row, end.row),
      startCol: Math.min(start.col, end.col),
      endRow: Math.max(start.row, end.row),
      endCol: Math.max(start.col, end.col),
    })
  })
  return ranges
}

function parseA1Range(rangeText) {
  const parts = String(rangeText || '').split(':')
  const start = parseA1Address(parts[0])
  const end = parseA1Address(parts[1] || parts[0])
  if (!start || !end) return null
  return {
    startRow: Math.min(start.row, end.row),
    startCol: Math.min(start.col, end.col),
    endRow: Math.max(start.row, end.row),
    endCol: Math.max(start.col, end.col),
  }
}

function extractWorksheetMergedCells(ws) {
  const merges = []
  const pushRange = (range) => {
    if (!range) return
    const { startRow, startCol, endRow, endCol } = range
    if (![startRow, startCol, endRow, endCol].every(Number.isFinite)) return
    const key = `${startRow}:${startCol}:${endRow}:${endCol}`
    if (!seen.has(key)) {
      seen.add(key)
      merges.push({ startRow, startCol, endRow, endCol })
    }
  }
  const seen = new Set()

  // ExcelJS 标准模型：['A1:C1', 'D2:E3', ...]
  const modelMerges = ws?.model?.merges
  if (Array.isArray(modelMerges)) {
    modelMerges.forEach(item => pushRange(parseA1Range(item)))
  }

  // 兼容部分版本的内部结构：_merges
  const internalMerges = ws?._merges
  if (internalMerges && typeof internalMerges === 'object') {
    Object.values(internalMerges).forEach(item => {
      if (!item) return
      if (typeof item === 'string') {
        pushRange(parseA1Range(item))
        return
      }
      if (typeof item.range === 'string') {
        pushRange(parseA1Range(item.range))
        return
      }
      if (item.model && typeof item.model === 'object') {
        const m = item.model
        pushRange({
          startRow: Number(m.top),
          startCol: Number(m.left),
          endRow: Number(m.bottom),
          endCol: Number(m.right),
        })
        return
      }
      if (typeof item.top === 'number' && typeof item.left === 'number' &&
          typeof item.bottom === 'number' && typeof item.right === 'number') {
        pushRange({
          startRow: Number(item.top),
          startCol: Number(item.left),
          endRow: Number(item.bottom),
          endCol: Number(item.right),
        })
      }
    })
  }

  return merges
}

function extractCommentText(note) {
  if (!note) return ''
  if (typeof note === 'string') return note.trim()
  if (Array.isArray(note?.texts)) {
    return note.texts.map(t => t?.text || '').join('').trim()
  }
  if (typeof note?.text === 'string') return note.text.trim()
  return ''
}

function extractCellHyperlink(cell) {
  if (!cell) return null

  let url = ''
  let text = ''

  if (typeof cell.hyperlink === 'string') {
    url = cell.hyperlink.trim()
  } else if (cell.hyperlink && typeof cell.hyperlink === 'object') {
    const rawUrl = cell.hyperlink.hyperlink || cell.hyperlink.target || cell.hyperlink.url
    url = typeof rawUrl === 'string' ? rawUrl.trim() : ''
    if (typeof cell.hyperlink.text === 'string') {
      text = cell.hyperlink.text.trim()
    }
  }

  if (!url && typeof cell.value?.hyperlink === 'string') {
    url = cell.value.hyperlink.trim()
  }
  if (!text && typeof cell.value?.text === 'string') {
    text = cell.value.text.trim()
  }

  if (!url) return null
  return { url, text }
}

function parseListValues(formula) {
  if (typeof formula !== 'string') return []
  const trimmed = formula.trim()
  if (!(trimmed.startsWith('"') && trimmed.endsWith('"'))) return []
  return trimmed
    .slice(1, -1)
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
}

function normalizeExcelDataValidation(dataValidation) {
  if (!dataValidation || typeof dataValidation !== 'object') return null
  const type = dataValidation.type
  if (!type) return null

  const formulae = Array.isArray(dataValidation.formulae) ? dataValidation.formulae : []
  const params = {}

  if (dataValidation.operator) params.operator = dataValidation.operator
  if (dataValidation.allowBlank !== undefined) params.allowBlank = !!dataValidation.allowBlank
  if (dataValidation.showErrorMessage !== undefined) params.showErrorMessage = !!dataValidation.showErrorMessage
  if (dataValidation.errorStyle) params.errorStyle = dataValidation.errorStyle
  if (dataValidation.errorTitle) params.errorTitle = dataValidation.errorTitle
  if (dataValidation.error) params.error = dataValidation.error
  if (dataValidation.showInputMessage !== undefined) params.showInputMessage = !!dataValidation.showInputMessage
  if (dataValidation.promptTitle) params.promptTitle = dataValidation.promptTitle
  if (dataValidation.prompt) params.prompt = dataValidation.prompt

  if (type === 'list') {
    const values = parseListValues(formulae[0])
    if (values.length > 0) params.values = values
    else if (formulae[0] !== undefined) params.source = formulae[0]
  } else if (formulae.length >= 2) {
    params.min = formulae[0]
    params.max = formulae[1]
  } else if (formulae.length === 1) {
    params.value = formulae[0]
  }

  if (formulae.length > 0) params.formulae = formulae

  return { type, params }
}

function extractWorksheetDataValidations(ws) {
  const rules = []
  const model = ws?.dataValidations?.model

  if (model && typeof model === 'object') {
    const entries = Array.isArray(model)
      ? model
      : Object.entries(model).map(([sqref, item]) => ({ ...(item || {}), sqref }))

    entries.forEach(item => {
      const validation = normalizeExcelDataValidation(item)
      if (!validation) return
      parseSqrefToRanges(item?.sqref).forEach(range => {
        rules.push({ ...range, validation })
      })
    })
  }

  if (rules.length > 0) return rules

  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const validation = normalizeExcelDataValidation(cell?.dataValidation)
      if (!validation) return
      rules.push({
        startRow: rowNumber,
        startCol: colNumber,
        endRow: rowNumber,
        endCol: colNumber,
        validation
      })
    })
  })

  return rules
}

/**
 * ExcelJS 富文本 -> 纯文本
 * cell.value = { richText: [{text: '...', font: {...}}, ...] }
 */
function flattenRichText(val) {
  if (val && typeof val === 'object' && Array.isArray(val.richText)) {
    return val.richText.map(r => r?.text ?? '').join('')
  }
  return null
}

/**
 * 将 ExcelJS cell 对象安全地转为前端 workbook 格式。
 * 修复：rich text 对象扁平化 + cell.text 兜底 + 通用 object 安全转换
 */
function normalizeExcelCell(cell) {
  if (!cell) return null
  const style = extractCellStyle(cell)
  const commentText = extractCommentText(cell.note)
  const comments = commentText ? [{ text: commentText, author: 'Excel' }] : undefined
  const hyperlink = extractCellHyperlink(cell)
  const formula = cell.formula || cell.value?.formula
  if (formula) {
    const result = { formula: `=${formula}`, value: cell.value?.result }
    if (style) result.style = style
    if (hyperlink) {
      result.hyperlink = {
        url: hyperlink.url,
        text: hyperlink.text || (result.value !== undefined && result.value !== null ? String(result.value) : hyperlink.url)
      }
    }
    if (comments) {
      result.comments = comments
      result.note = commentText
    }
    return result
  }

  let normalizedValue = cell.value

  // ── Rich text 扁平化（优先级最高）──
  const rtPlain = flattenRichText(normalizedValue)
  if (rtPlain !== null) normalizedValue = rtPlain

  // ── ExcelJS cell.text 兜底（覆盖 SharedString / RichText 等内部类型）──
  if ((normalizedValue === undefined || normalizedValue === null)
      && typeof cell.text === 'string' && cell.text) {
    normalizedValue = cell.text
  }

  // ── 通用 object 安全转换：避免 [object Object] 残留 ──
  if (normalizedValue && typeof normalizedValue === 'object' && !hyperlink) {
    if (typeof normalizedValue.text === 'string') {
      normalizedValue = normalizedValue.text
    } else if (normalizedValue instanceof Date) {
      // ExcelJS 在 numFmt 为日期格式时返回 Date 对象，
      // 但「数量/金额」等数值列若被 Excel 意外设置日期格式，
      // 原值 2 会变成 Date(1900-01-02)，直接 toISOString 会彻底损坏数据。
      // 策略：仅当 numFmt 确实含日期标记 且 年份 >= 1930 时才视为真实日期。
      const yr = normalizedValue.getUTCFullYear()
      if (_isDateNumFmt(cell.numFmt) && yr >= 1930) {
        normalizedValue = normalizedValue.toISOString()
      } else {
        normalizedValue = _jsDateToExcelSerial(normalizedValue)
      }
    } else if (typeof normalizedValue.result !== 'undefined') {
      normalizedValue = normalizedValue.result
    }
  }

  if (hyperlink) {
    if (normalizedValue && typeof normalizedValue === 'object') {
      const objectText = normalizedValue.text ?? cell.text ?? hyperlink.text
      normalizedValue = objectText || hyperlink.url
    } else if (normalizedValue === undefined || normalizedValue === null || normalizedValue === '') {
      normalizedValue = hyperlink.text || hyperlink.url
    }
  }

  if (cell.value === undefined || cell.value === null) {
    // cell.text 兜底可能已恢复了值
    if (normalizedValue != null && normalizedValue !== '') {
      const result = { value: normalizedValue }
      if (style) result.style = style
      if (hyperlink) {
        result.hyperlink = {
          url: hyperlink.url,
          text: hyperlink.text || String(result.value)
        }
      }
      if (comments) { result.comments = comments; result.note = commentText }
      return result
    }
    if (!style && !comments && !hyperlink) return null
    const result = { value: normalizedValue ?? '' }
    if (style) result.style = style
    if (hyperlink) {
      result.hyperlink = {
        url: hyperlink.url,
        text: hyperlink.text || (result.value !== undefined && result.value !== null ? String(result.value) : hyperlink.url)
      }
    }
    if (comments) {
      result.comments = comments
      result.note = commentText
    }
    return result
  }
  const result = { value: normalizedValue }
  if (style) result.style = style
  if (hyperlink) {
    result.hyperlink = {
      url: hyperlink.url,
      text: hyperlink.text || (result.value !== undefined && result.value !== null ? String(result.value) : hyperlink.url)
    }
  }
  if (comments) {
    result.comments = comments
    result.note = commentText
  }
  return result
}

/**
 * Excel Table（ListObject）表头恢复
 * ExcelJS 对部分 xlsx 文件的表头行返回 cell.value=null，
 * 因为表头名仅存于 table XML 定义而非 sharedStrings。
 * 从 ws._tables / ws.model.tables 中提取列名回填缺失单元格。
 */
function recoverTableHeaders(ws, data) {
  const tables = []

  // ExcelJS 内部结构：_tables 数组
  try {
    const raw = ws._tables || ws.tables
    const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : [])
    list.forEach(store => {
      const tbl = store?.table || store
      if (tbl?.tableRef && Array.isArray(tbl.columns)) tables.push(tbl)
    })
  } catch { /* best-effort */ }

  // 回退：model.tables
  if (tables.length === 0) {
    try {
      const mt = ws.model?.tables
      const list = Array.isArray(mt) ? mt : (mt && typeof mt === 'object' ? Object.values(mt) : [])
      list.forEach(tbl => {
        const inner = tbl?.table || tbl
        if (inner?.tableRef && Array.isArray(inner.columns)) tables.push(inner)
      })
    } catch { /* best-effort */ }
  }

  for (const tbl of tables) {
    const topLeft = parseA1Address((tbl.tableRef || '').split(':')[0])
    if (!topLeft) continue
    const headerRow = topLeft.row
    const startCol = topLeft.col

    tbl.columns.forEach((col, idx) => {
      if (!col?.name) return
      const colNum = startCol + idx
      const existing = data[headerRow]?.[colNum]
      if (existing?.value != null && existing.value !== '') return
      if (!data[headerRow]) data[headerRow] = {}
      data[headerRow][colNum] = { ...(existing || {}), value: col.name }
    })
  }
}

/**
 * AutoFilter 表头恢复
 * 当 ws.autoFilter 存在但表头行单元格值为空时，
 * 尝试通过 ws.getRow().getCell() 显式读取每个单元格。
 */
function recoverAutoFilterHeaders(ws, data) {
  const af = ws.autoFilter
  if (!af) return

  let ref = typeof af === 'string' ? af : af.ref
  if (!ref) return

  const topLeft = parseA1Address(ref.split(':')[0])
  const bottomRight = parseA1Address(ref.split(':')[1])
  if (!topLeft || !bottomRight) return

  const headerRow = topLeft.row
  const startCol = topLeft.col
  const endCol = bottomRight.col

  // 如果表头行已完整填充，跳过
  let missingCount = 0
  for (let c = startCol; c <= endCol; c++) {
    if (!data[headerRow]?.[c] || data[headerRow][c].value == null || data[headerRow][c].value === '') {
      missingCount++
    }
  }
  if (missingCount === 0) return

  // 通过 getRow/getCell 强制读取（ExcelJS 在 eachCell 时可能跳过了这些单元格）
  try {
    const row = ws.getRow(headerRow)
    if (!row) return
    for (let c = startCol; c <= endCol; c++) {
      const existing = data[headerRow]?.[c]
      if (existing?.value != null && existing.value !== '') continue

      const cell = row.getCell(c)
      if (!cell) continue
      // 合并从属单元格的 .value 返回主单元格值 → 跳过，
      // 避免抵消主导入循环的"跳过从属格"修复
      if (cell.isMerged && cell.master && cell.master !== cell) continue
      const normalized = normalizeExcelCell(cell)
      if (!normalized || (normalized.value == null && !normalized.style)) continue

      if (!data[headerRow]) data[headerRow] = {}
      data[headerRow][c] = { ...(existing || {}), ...normalized }
    }
  } catch { /* best-effort */ }
}

export function exceljsToWorkbook(excelWb) {
  const metaSheet = excelWb.getWorksheet('__SHEETBOT_META__')
  let chartMetaBySheet = {}
  if (metaSheet) {
    try {
      const raw = metaSheet.getCell(1, 1)?.value
      const metaText = typeof raw === 'string' ? raw : raw?.toString?.()
      const parsed = metaText ? JSON.parse(metaText) : {}
      chartMetaBySheet = parsed?.charts || {}
    } catch {
      chartMetaBySheet = {}
    }
  }

  const sheets = excelWb.worksheets
    .filter(ws => ws.name !== '__SHEETBOT_META__')
    .map(ws => {
    const data = {}
    const rowHeights = {}
    const worksheetColumns = Array.isArray(ws.columns) ? ws.columns : []
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (row.height) {
        rowHeights[rowNumber] = Math.round(row.height / 0.75)
      }
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        // ExcelJS 对合并从属单元格 (slave) 的 .value 返回主单元格值，
        // 导致合并标题行所有列都写入相同值 → 下游表头检测/汇总全部污染。
        // 仅保留主单元格 (master) 的值；从属单元格跳过写入。
        if (cell.isMerged && cell.master && cell.master !== cell) return
        const normalized = normalizeExcelCell(cell)
        if (!normalized) return
        if (!data[rowNumber]) data[rowNumber] = {}
        data[rowNumber][colNumber] = normalized
      })
    })

    // ── Excel Table / AutoFilter 表头恢复 ──
    recoverTableHeaders(ws, data)
    recoverAutoFilterHeaders(ws, data)
    const images = extractWorksheetImages(ws, excelWb)
    images.forEach((img) => {
      if (!data[img.row]) data[img.row] = {}
      const prev = data[img.row][img.col] || {}
      data[img.row][img.col] = {
        ...prev,
        image: {
          src: img.src,
          rowSpan: img.rowSpan,
          colSpan: img.colSpan,
          width: img.width,
          height: img.height,
        }
      }
    })
    return {
      name: ws.name,
      data,
      rowCount: ws.rowCount || 0,
      colCount: ws.columnCount || 0,
      tabColor: extractWorksheetTabColor(ws),
      hidden: ws.state === 'hidden' || ws.state === 'veryHidden',
      colWidths: Object.fromEntries(
        worksheetColumns
          .map((c, i) => [i + 1, c?.width ? Math.round(c.width * 8) : undefined])
          .filter(([, v]) => v !== undefined)
      ),
      rowHeights,
      mergedCells: extractWorksheetMergedCells(ws),
      dataValidations: extractWorksheetDataValidations(ws),
      charts: Array.isArray(chartMetaBySheet[ws.name]) ? chartMetaBySheet[ws.name] : [],
      images
    }
  })
  return { sheets, activeSheet: sheets[0]?.name || 'Sheet1' }
}
