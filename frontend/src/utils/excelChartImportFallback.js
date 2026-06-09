// ============================================================================
// Excel 嵌入图表导入降级 + 导入后 AI 重新出图
// ============================================================================

/** 与 GOAL_PRESETS 智能分析一致，并说明图表未导入背景 */
export const CHART_REGEN_AFTER_IMPORT_COMMAND =
  '原文件的 Excel 嵌入图表因格式兼容未能导入。请基于当前已加载的完整表格数据，自动进行智能分析并生成不超过 3 张最有解释力的图表（先汇总再出图），并简要总结关键发现。'

export const CHART_REGEN_STATUS_MESSAGE =
  '原文件图表未能导入，正在根据已加载数据自动重新生成图表…'

export const CHART_REGEN_SKIP_MESSAGE =
  '原文件图表未能导入；当前未连接 AI 或正在处理其它任务，请稍后点击「智能分析并出图」手动重新生成。'

/**
 * ExcelJS 对部分锚点类型图表会抛 anchors 错误；剥离 chart/drawing 后重试。
 * @returns {Promise<boolean>} true 表示走了降级（原图表已丢弃）
 */
export async function loadXlsxWithChartFallback(excelWb, arrayBuffer) {
  try {
    await excelWb.xlsx.load(arrayBuffer)
    return false
  } catch (err) {
    if (!String(err?.message || '').includes('anchors')) throw err

    const { default: JSZip } = await import('jszip')
    const zip = await JSZip.loadAsync(arrayBuffer)

    const sheetXmlFiles = Object.keys(zip.files).filter(
      (name) => name.startsWith('xl/worksheets/sheet') && name.endsWith('.xml')
    )
    for (const sheetXml of sheetXmlFiles) {
      const xml = await zip.file(sheetXml)?.async('string')
      if (!xml) continue
      const sanitized = xml
        .replace(/<drawing\b[^>]*\/>/g, '')
        .replace(/<legacyDrawing\b[^>]*\/>/g, '')
      zip.file(sheetXml, sanitized)
    }

    const relFiles = Object.keys(zip.files).filter(
      (name) => name.startsWith('xl/worksheets/_rels/') && name.endsWith('.rels')
    )
    for (const relFile of relFiles) {
      const relXml = await zip.file(relFile)?.async('string')
      if (!relXml) continue
      const sanitizedRel = relXml.replace(
        /<Relationship\b[^>]*Type="[^"]*(?:\/drawing|\/chart)[^"]*"[^>]*\/>/g,
        ''
      )
      zip.file(relFile, sanitizedRel)
    }

    Object.keys(zip.files).forEach((name) => {
      if (
        name.startsWith('xl/drawings/') ||
        name.startsWith('xl/charts/') ||
        name.startsWith('xl/chartsheets/')
      ) {
        zip.remove(name)
      }
    })

    const stripped = await zip.generateAsync({ type: 'arraybuffer' })
    await excelWb.xlsx.load(stripped)
    return true
  }
}
