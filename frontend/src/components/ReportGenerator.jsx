// frontend/src/components/ReportGenerator.jsx
/**
 * ===================================
 * 报表生成组件
 * - 智能维度推荐
 * - 维度选择器
 * - ECharts图表展示
 * - 文字解读
 * - 报表下载（PDF/Word/PNG）
 * ===================================
 */
import React, { useState, useEffect, useRef } from 'react'
import { X, Loader2, Download, FileText, Sparkles } from 'lucide-react'
import { useConfig } from '../contexts/ConfigContext'
import ReactECharts from 'echarts-for-react'
import ReactMarkdown from 'react-markdown'
import jsPDF from 'jspdf'
import html2canvas from 'html2canvas'
import { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, ImageRun, TextRun } from 'docx'
import appConfig from '../config/appConfig'

function ReportGenerator({ isOpen, onClose, fileId, largeFileInfo }) {
  const { formatInUserTimezone } = useConfig()
  // 获取API基础URL
  const getApiBaseUrl = () => {
    return appConfig.apiBaseUrl || ''
  }
  const getUserDateForFilename = () => {
    const dateOnly = formatInUserTimezone(new Date().toISOString(), {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: undefined,
      minute: undefined,
      second: undefined,
    })
    return String(dateOnly).replace(/[^\d]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  }
  const getUserNowLabel = () => formatInUserTimezone(new Date().toISOString())
  const [analyzing, setAnalyzing] = useState(false)
  const [recommendedDimensions, setRecommendedDimensions] = useState(null)
  const [selectedDimensions, setSelectedDimensions] = useState(null)
  const [generating, setGenerating] = useState(false)
  const [reportData, setReportData] = useState(null)
  const [reportId, setReportId] = useState(null)
  const reportContentRef = useRef(null)
  
  // 基础维度选择器状态
  const [fileStructure, setFileStructure] = useState(null)
  const [timeDimension, setTimeDimension] = useState('')
  const [categoryDimensions, setCategoryDimensions] = useState([])
  const [statistics, setStatistics] = useState(['求和'])
  const [valueFields, setValueFields] = useState([])
  
  // 识别出的字段
  const [timeFields, setTimeFields] = useState([])
  const [categoryFields, setCategoryFields] = useState([])
  const [numericFields, setNumericFields] = useState([])
  
  // 关联字段相关状态
  const [allSheets, setAllSheets] = useState([]) // 所有工作表列表
  const [sheetColumns, setSheetColumns] = useState({}) // {工作表名: [列名列表]}
  const [joinKeys, setJoinKeys] = useState({}) // {工作表名: 关联字段名}，例如 {"产品明细": "产品ID", "销售明细": "产品ID"}
  const [exportingPDF, setExportingPDF] = useState(false) // PDF导出状态
  const [exportingPNG, setExportingPNG] = useState(false) // PNG导出状态

  // 获取文件结构信息（仅在首次打开时重置，支持多次生成）
  useEffect(() => {
    if (isOpen && fileId && largeFileInfo && !fileStructure) {
      // 仅在首次打开时重置状态
      setAnalyzing(false)
      setRecommendedDimensions(null)
      setFileStructure(null)
      setTimeDimension('')
      setCategoryDimensions([])
      setStatistics(['求和'])
      setValueFields([])
      setJoinKeys({}) // 重置关联字段
      
      // 加载文件结构
      loadFileStructure()
    }
  }, [isOpen, fileId, largeFileInfo])
  
  // 加载文件结构（从所有工作表获取字段）
  const loadFileStructure = async () => {
    if (!fileId) return
    
    try {
      const baseUrl = getApiBaseUrl()
      const response = await fetch(`${baseUrl}/api/large-file/status/${fileId}`)
      if (!response.ok) return
      
      const status = await response.json()
      
      // 从所有工作表获取字段并合并
      if (status.sheet_names && status.sheet_names.length > 0) {
        const allTimeFields = new Set()
        const allCategoryFields = new Set()
        const allNumericFields = new Set()
        const sheetsColumnsMap = {} // 存储每个工作表的列名
        
        // 保存工作表列表
        setAllSheets(status.sheet_names)
        
        // 遍历所有工作表
        for (const sheetName of status.sheet_names) {
          try {
            const previewResponse = await fetch(`${baseUrl}/api/large-file/preview/${fileId}?sheet_name=${encodeURIComponent(sheetName)}`)
            if (previewResponse.ok) {
              const preview = await previewResponse.json()
              const { timeFields: tf, categoryFields: cf, numericFields: nf } = analyzeFieldsFromPreview(preview, sheetName, status.sheet_names)
              
              // 保存该工作表的列名
              sheetsColumnsMap[sheetName] = preview.headers || []
              
              // 合并字段（使用"工作表名.字段名"格式，避免重名冲突）
              tf.forEach(field => allTimeFields.add(field))
              cf.forEach(field => allCategoryFields.add(field))
              nf.forEach(field => allNumericFields.add(field))
            }
          } catch (error) {
            console.warn(`加载工作表 ${sheetName} 失败:`, error)
          }
        }
        
        // 设置合并后的字段列表
        setTimeFields(Array.from(allTimeFields).sort())
        setCategoryFields(Array.from(allCategoryFields).sort())
        setNumericFields(Array.from(allNumericFields).sort())
        setSheetColumns(sheetsColumnsMap)
      }
    } catch (error) {
      console.error('加载文件结构失败:', error)
    }
  }
  
  // 从预览数据中分析字段类型（返回字段列表）
  const analyzeFieldsFromPreview = (preview, sheetName, allSheetNames) => {
    const headers = preview.headers || []
    const data = preview.data || []
    
    const timeFieldsList = []
    const categoryFieldsList = []
    const numericFieldsList = []
    
    // 判断是否需要添加工作表前缀（多个工作表时才添加）
    const needPrefix = allSheetNames && allSheetNames.length > 1
    
    headers.forEach((header, idx) => {
      if (!header) return
      
      // 使用"工作表名.字段名"格式，避免不同工作表的同名字段冲突
      const fieldName = needPrefix ? `${sheetName}.${header}` : header
      
      const headerLower = header.toLowerCase()
      
      // 识别时间字段
      if (headerLower.includes('日期') || headerLower.includes('时间') || 
          headerLower.includes('年') || headerLower.includes('月') || 
          headerLower.includes('日') || headerLower.includes('date') || 
          headerLower.includes('time')) {
        timeFieldsList.push(fieldName)
      }
      
      // 分析列数据
      const columnValues = data.slice(0, 100).map(row => row[idx]).filter(v => v != null && v !== '')
      if (columnValues.length === 0) return
      
      // 判断是否为数值
      const isNumeric = columnValues.every(v => {
        if (typeof v === 'number') return true
        if (typeof v === 'string') {
          const num = parseFloat(v.replace(/[^\d.-]/g, ''))
          return !isNaN(num) && isFinite(num)
        }
        return false
      })
      
      if (isNumeric) {
        numericFieldsList.push(fieldName)
      } else {
        // 判断是否为分类字段（唯一值数量 < 总行数的20%）
        const uniqueValues = new Set(columnValues.map(v => String(v)))
        if (uniqueValues.size < columnValues.length * 0.2 && uniqueValues.size > 0) {
          categoryFieldsList.push(fieldName)
        }
      }
    })
    
    return {
      timeFields: timeFieldsList,
      categoryFields: categoryFieldsList,
      numericFields: numericFieldsList
    }
  }
  

  // 分析维度
  const handleAnalyzeDimensions = async () => {
    if (!fileId) return
    
    setAnalyzing(true)
    try {
      const baseUrl = getApiBaseUrl()
      const response = await fetch(`${baseUrl}/api/large-file/analyze-dimensions/${fileId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
      
      if (!response.ok) {
        throw new Error('分析失败')
      }
      
      const data = await response.json()
      setRecommendedDimensions(data)
      
      // 自动选择推荐的维度
      if (data.recommended_dimensions && data.recommended_dimensions.length > 0) {
        setSelectedDimensions(data.recommended_dimensions[0])
      }
    } catch (error) {
      console.error('分析维度失败:', error)
      alert('分析维度失败，请稍后重试')
    } finally {
      setAnalyzing(false)
    }
  }

  // 检测选择的字段来自哪些工作表
  const getSelectedSheets = () => {
    const selectedFields = [
      timeDimension,
      ...categoryDimensions,
      ...valueFields
    ].filter(Boolean)
    
    // 如果使用了推荐维度，也要包含
    if (selectedDimensions) {
      if (selectedDimensions.time_field) selectedFields.push(selectedDimensions.time_field)
      if (selectedDimensions.category_dimensions) selectedFields.push(...selectedDimensions.category_dimensions)
      if (selectedDimensions.value_fields) selectedFields.push(...selectedDimensions.value_fields)
    }
    
    // 提取工作表名（从"工作表名.字段名"格式中提取）
    const sheets = new Set()
    selectedFields.forEach(field => {
      if (field.includes('.')) {
        const sheetName = field.split('.')[0]
        sheets.add(sheetName)
      } else if (allSheets.length === 1) {
        // 单个工作表，字段名没有前缀
        sheets.add(allSheets[0])
      }
    })
    
    return Array.from(sheets)
  }

  // 找出多个工作表之间的共同字段名
  const findCommonFields = (sheets) => {
    if (sheets.length < 2) return []
    
    // 获取每个工作表的字段列表
    const sheetFieldLists = sheets.map(sheet => {
      const columns = sheetColumns[sheet] || []
      return columns.map(col => col.trim()).filter(Boolean)
    })
    
    // 如果任何一个工作表没有字段数据，返回空数组
    if (sheetFieldLists.some(fields => fields.length === 0)) {
      return []
    }
    
    // 找出所有工作表中都存在的字段（交集）
    const commonFields = sheetFieldLists[0].filter(field => 
      sheetFieldLists.every(fields => fields.includes(field))
    )
    
    return commonFields
  }

  // 自动匹配关联字段：当检测到多个工作表时，自动选择共同字段
  useEffect(() => {
    const selectedSheets = getSelectedSheets()
    
    // 仅在多个工作表时执行自动匹配
    if (selectedSheets.length < 2) {
      return
    }
    
    // 检查所有工作表的字段数据是否已加载
    const allSheetsHaveColumns = selectedSheets.every(sheet => {
      const columns = sheetColumns[sheet]
      return columns && columns.length > 0
    })
    
    if (!allSheetsHaveColumns) {
      return // 等待字段数据加载完成
    }
    
    // 使用函数式更新，避免依赖 joinKeys 导致循环
    setJoinKeys(prevJoinKeys => {
      // 检查是否有未选择关联字段的工作表
      const unselectedSheets = selectedSheets.filter(sheet => {
        const selectedKey = prevJoinKeys[sheet]
        return !selectedKey || !selectedKey.trim()
      })
      
      // 如果所有工作表都已选择，不进行自动匹配（尊重用户选择）
      if (unselectedSheets.length === 0) {
        return prevJoinKeys
      }
      
      // 找出共同字段
      const commonFields = findCommonFields(selectedSheets)
      
      if (commonFields.length > 0) {
        // 如果有共同字段，自动选择第一个共同字段
        const autoSelectedField = commonFields[0]
        const newJoinKeys = { ...prevJoinKeys }
        let hasChanges = false
        
        // 只为未选择的工作表自动选择
        unselectedSheets.forEach(sheet => {
          newJoinKeys[sheet] = autoSelectedField
          hasChanges = true
        })
        
        // 只有当有变化时才返回新对象
        return hasChanges ? newJoinKeys : prevJoinKeys
      }
      
      // 如果没有共同字段，保持原状态，让用户手动选择
      return prevJoinKeys
    })
  }, [timeDimension, categoryDimensions, valueFields, selectedDimensions, sheetColumns, allSheets])

  // 生成报表
  const handleGenerateReport = async () => {
    if (!fileId) {
      alert('文件ID不存在')
      return
    }
    
    // 检测选择的字段来自哪些工作表
    const selectedSheets = getSelectedSheets()
    
    // 如果选择了多个工作表，必须为每个工作表选择关联字段
    if (selectedSheets.length > 1) {
      const missingSheets = selectedSheets.filter(sheet => !joinKeys[sheet] || !joinKeys[sheet].trim())
      if (missingSheets.length > 0) {
        alert(`您选择了多个工作表的字段，必须为每个工作表选择一个关联字段才能生成报表。\n\n缺少关联字段的工作表：${missingSheets.join('、')}\n\n关联字段用于连接不同工作表的数据，避免产生大量无意义的数据组合。`)
        return
      }
      
      // 验证所有工作表的关联字段是否一致（应该选择相同的字段名）
      const joinKeyValues = selectedSheets.map(sheet => joinKeys[sheet]).filter(Boolean)
      const uniqueJoinKeys = new Set(joinKeyValues)
      if (uniqueJoinKeys.size > 1) {
        alert(`警告：您为不同工作表选择了不同的关联字段。\n\n建议：所有工作表应该选择相同的关联字段（如：产品ID、订单ID等）才能正确关联数据。\n\n当前选择：\n${selectedSheets.map(sheet => `  ${sheet}: ${joinKeys[sheet]}`).join('\n')}\n\n是否继续生成报表？`)
        // 用户可以选择继续，所以不return
      }
    }
    
    // 构建维度配置
    let dimensions = selectedDimensions
    if (!dimensions || Object.keys(dimensions).length === 0) {
      // 如果没有选择推荐维度，使用基础维度配置
      const selectedTimeDim = selectedDimensions?.time_dimension || (timeDimension ? '月' : null)
      dimensions = {
        time_dimension: selectedTimeDim,
        time_field: timeDimension || null,
        category_dimensions: categoryDimensions.length > 0 ? categoryDimensions : [],
        statistics: statistics.length > 0 ? statistics : ['求和'],
        value_fields: valueFields.length > 0 ? valueFields : [],
        join_keys: selectedSheets.length > 1 ? joinKeys : null // 添加关联字段映射
      }
      
      // 验证至少选择了一个维度
      if (!dimensions.time_dimension && dimensions.category_dimensions.length === 0 && dimensions.value_fields.length === 0) {
        alert('请至少选择一个报表维度（时间维度、分类维度或数值字段）')
        return
      }
    } else {
      // 如果选择了推荐维度，确保time_field也被传递
      if (dimensions.time_dimension && !dimensions.time_field && timeDimension) {
        dimensions.time_field = timeDimension
      }
      // 添加关联字段映射
      const selectedSheetsForDim = getSelectedSheets()
      dimensions.join_keys = selectedSheetsForDim.length > 1 ? joinKeys : null
    }
    
    setGenerating(true)
    setReportData(null)
    
    try {
      const baseUrl = getApiBaseUrl()
      const response = await fetch(`${baseUrl}/api/large-file/generate-report/${fileId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dimensions: dimensions,
          sheet_name: largeFileInfo?.sheet_names?.[0] || null
        })
      })
      
      if (!response.ok) {
        throw new Error('生成报表失败')
      }
      
      const data = await response.json()
      setReportId(data.report_id)
      
      // 轮询获取报表结果
      pollReportStatus(data.report_id)
    } catch (error) {
      console.error('生成报表失败:', error)
      alert('生成报表失败，请稍后重试')
      setGenerating(false)
    }
  }

  // 轮询报表状态（支持动态加载）
  const pollReportStatus = async (id) => {
    const maxAttempts = 120 // 最多轮询120次（10分钟）
    let attempts = 0
    
    const poll = async () => {
      try {
        const baseUrl = getApiBaseUrl()
        const response = await fetch(`${baseUrl}/api/large-file/report/${id}`)
        if (!response.ok) {
          throw new Error('获取报表状态失败')
        }
        
        const data = await response.json()
        
        // 动态更新报表数据（即使还在生成中）
        if (data.charts && data.charts.length > 0) {
          // 如果有图表数据，立即展示
          setReportData(prev => ({
            ...prev,
            ...data,
            // 保留已有的insights和key_metrics，避免被覆盖
            insights: data.insights || prev?.insights,
            key_metrics: data.key_metrics || prev?.key_metrics
          }))
        } else if (data.title) {
          // 如果有标题，至少显示标题
          setReportData(prev => ({
            ...prev,
            title: data.title,
            progress: data.progress,
            key_metrics: data.key_metrics || prev?.key_metrics
          }))
        }
        
        // 如果有key_metrics数据，立即更新
        if (data.key_metrics && data.key_metrics.length > 0) {
          setReportData(prev => ({
            ...prev,
            ...data,
            key_metrics: data.key_metrics
          }))
        }
        
        if (data.status === 'completed') {
          setReportData(data)
          setGenerating(false)
          return
        }
        
        if (data.status === 'failed') {
          throw new Error(data.error || '报表生成失败')
        }
        
        // 继续轮询（更频繁的轮询以支持动态加载）
        attempts++
        if (attempts < maxAttempts) {
          setTimeout(poll, 2000) // 每2秒轮询一次，更快响应
        } else {
          throw new Error('报表生成超时')
        }
      } catch (error) {
        console.error('轮询报表状态失败:', error)
        alert(error.message || '获取报表状态失败')
        setGenerating(false)
      }
    }
    
    poll()
  }

  // 将ECharts图表转换为图片（提高分辨率）
  const chartRefs = useRef({})
  
  const getChartImage = async (chartOption, chartId) => {
    try {
      // 创建一个临时的ECharts实例来生成图片
      const echarts = await import('echarts')
      const chartDom = document.createElement('div')
      chartDom.style.width = '1200px' // 提高宽度以获得更高分辨率
      chartDom.style.height = '600px' // 提高高度
      chartDom.style.position = 'absolute'
      chartDom.style.left = '-9999px'
      document.body.appendChild(chartDom)
      
      const chart = echarts.init(chartDom)
      chart.setOption(chartOption)
      
      // 等待图表渲染完成
      await new Promise(resolve => setTimeout(resolve, 800))
      
      const imageData = chart.getDataURL({
        type: 'png',
        pixelRatio: 3, // 提高分辨率
        backgroundColor: '#ffffff'
      })
      
      chart.dispose()
      document.body.removeChild(chartDom)
      
      return imageData
    } catch (error) {
      console.error('生成图表图片失败:', error)
      return null
    }
  }

  // 解析Markdown表格
  const parseMarkdownTable = (markdownText) => {
    const tables = []
    const lines = markdownText.split('\n')
    let currentTable = null
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      
      // 检测表格开始（表头行）
      if (line.startsWith('|') && line.endsWith('|') && !line.match(/^[\s|:-]+$/)) {
        const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : ''
        const isSeparator = nextLine.match(/^[\s|:-]+$/)
        
        if (isSeparator) {
          // 解析表头
          const headers = line.split('|').map(h => h.trim()).filter(h => h)
          currentTable = {
            headers,
            rows: [],
            startLine: i
          }
          i++ // 跳过分隔行
        }
      } else if (currentTable && line.startsWith('|') && line.endsWith('|')) {
        // 数据行
        const cells = line.split('|').map(c => c.trim()).filter((c, idx) => idx > 0 && idx < currentTable.headers.length + 1)
        if (cells.length === currentTable.headers.length) {
          currentTable.rows.push(cells)
        }
      } else if (currentTable && (line === '' || !line.startsWith('|'))) {
        // 表格结束
        if (currentTable.rows.length > 0) {
          tables.push(currentTable)
        }
        currentTable = null
      }
    }
    
    // 处理最后一个表格
    if (currentTable && currentTable.rows.length > 0) {
      tables.push(currentTable)
    }
    
    return tables
  }

  // 加载中文字体（使用CDN）
  const loadChineseFont = async () => {
    try {
      // 使用jsPDF的字体插件加载中文字体
      // 这里使用一个简化的方法：使用Unicode编码支持
      // 实际项目中应该加载字体文件
      return true
    } catch (error) {
      console.warn('加载中文字体失败，将使用默认字体:', error)
      return false
    }
  }

  // 导出PDF（调用后端API）
  const handleExportPDF = async () => {
    if (!reportData || !reportId || exportingPDF) return
    
    setExportingPDF(true)
    try {
      const baseUrl = getApiBaseUrl()
      const response = await fetch(`${baseUrl}/api/large-file/export-report/${reportId}?format=pdf`)
      
      if (!response.ok) {
        throw new Error(`导出失败: ${response.statusText}`)
      }
      
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `报表_${getUserDateForFilename()}.pdf`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    } catch (error) {
      console.error('导出PDF失败:', error)
      alert('导出PDF失败: ' + error.message)
    } finally {
      setExportingPDF(false)
    }
  }
  
  // 导出PNG（调用后端API）
  const handleExportPNG = async () => {
    if (!reportData || !reportId || exportingPNG) return
    
    setExportingPNG(true)
    try {
      const baseUrl = getApiBaseUrl()
      const response = await fetch(`${baseUrl}/api/large-file/export-report/${reportId}?format=png`)
      
      if (!response.ok) {
        throw new Error(`导出失败: ${response.statusText}`)
      }
      
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `报表_${getUserDateForFilename()}.png`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    } catch (error) {
      console.error('导出PNG失败:', error)
      alert('导出PNG失败: ' + error.message)
    } finally {
      setExportingPNG(false)
    }
  }
  
  // 旧的导出函数（已废弃，保留以防需要回退）
  const handleExportPDF_OLD = async () => {
    if (!reportData) return
    
    try {
      const pdf = new jsPDF('p', 'mm', 'a4')
      const pageWidth = 210 // A4宽度（mm）
      const pageHeight = 297 // A4高度（mm）
      const margin = 20 // 页边距（mm）
      const contentWidth = pageWidth - 2 * margin
      let yPosition = margin
      const lineHeight = 7 // 行高（mm）
      
      // 尝试加载中文字体，如果失败则使用Unicode编码
      // 注意：jsPDF默认不支持中文，需要使用支持中文的字体
      // 这里我们使用一个变通方法：将中文转换为Unicode编码
      const encodeChinese = (text) => {
        // 对于不支持中文的情况，使用Unicode转义
        // 但更好的方法是加载中文字体文件
        return text
      }
      
      // 设置字体（使用支持Unicode的字体）
      pdf.setFont('helvetica')
      
      // 使用html2canvas将内容渲染为图片，然后插入PDF（解决中文乱码问题）
      // 这是最可靠的方法，确保中文正确显示
      const renderContentToImage = async (element) => {
        try {
          const canvas = await html2canvas(element, {
            scale: 3, // 提高分辨率
            useCORS: true,
            backgroundColor: '#ffffff',
            logging: false
          })
          return canvas.toDataURL('image/png')
        } catch (error) {
          console.error('渲染内容为图片失败:', error)
          return null
        }
      }
      
      // 1. 标题和生成时间
      const titleSection = document.createElement('div')
      titleSection.style.padding = '20px'
      titleSection.style.fontFamily = 'Arial, "Microsoft YaHei", sans-serif'
      titleSection.innerHTML = `
        <h1 style="font-size: 24px; font-weight: bold; margin: 0 0 10px 0;">${reportData.title || '企业级报表'}</h1>
        <p style="font-size: 12px; color: #666; margin: 0;">生成时间: ${getUserNowLabel()}</p>
      `
      document.body.appendChild(titleSection)
      const titleImage = await renderContentToImage(titleSection)
      document.body.removeChild(titleSection)
      
      if (titleImage) {
        const imgWidth = contentWidth
        const imgHeight = (imgWidth * 60) / contentWidth // 估算高度
        pdf.addImage(titleImage, 'PNG', margin, yPosition, imgWidth, imgHeight)
        yPosition += imgHeight + 5
      } else {
        // 备用方案：直接使用文本（可能乱码）
        pdf.setFontSize(20)
        pdf.setFont('helvetica', 'bold')
        pdf.text(reportData.title || '企业级报表', margin, yPosition, { maxWidth: contentWidth })
        yPosition += 10
        pdf.setFontSize(10)
        pdf.setFont('helvetica', 'normal')
        pdf.setTextColor(100, 100, 100)
        pdf.text(`生成时间: ${getUserNowLabel()}`, margin, yPosition)
        yPosition += 8
        pdf.setTextColor(0, 0, 0)
      }
      
      // 3. 核心指标表格
      if (reportData.key_metrics && reportData.key_metrics.length > 0) {
        // 检查是否需要新页面
        if (yPosition > pageHeight - 100) {
          pdf.addPage()
          yPosition = margin
        }
        
        // 渲染表格为图片
        const tableSection = document.createElement('div')
        tableSection.style.padding = '20px'
        tableSection.style.fontFamily = 'Arial, "Microsoft YaHei", sans-serif'
        tableSection.style.backgroundColor = '#ffffff'
        
        let tableHTML = '<h2 style="font-size: 18px; font-weight: bold; margin: 0 0 10px 0;">核心指标概览</h2>'
        tableHTML += '<table style="width: 100%; border-collapse: collapse; font-size: 12px;">'
        tableHTML += '<thead><tr style="background-color: #217346; color: white;">'
        tableHTML += '<th style="padding: 8px; text-align: left; border: 1px solid #ddd;">指标名称</th>'
        tableHTML += '<th style="padding: 8px; text-align: right; border: 1px solid #ddd;">数值</th>'
        tableHTML += '<th style="padding: 8px; text-align: left; border: 1px solid #ddd;">说明</th>'
        tableHTML += '</tr></thead><tbody>'
        
        reportData.key_metrics.forEach((metric, idx) => {
          const bgColor = idx % 2 === 0 ? '#f9f9f9' : '#ffffff'
          tableHTML += `<tr style="background-color: ${bgColor};">`
          tableHTML += `<td style="padding: 8px; border: 1px solid #ddd;">${metric.name || ''}</td>`
          tableHTML += `<td style="padding: 8px; text-align: right; border: 1px solid #ddd;">${metric.value || ''}${metric.unit || ''}</td>`
          tableHTML += `<td style="padding: 8px; border: 1px solid #ddd;">${metric.description || ''}</td>`
          tableHTML += '</tr>'
        })
        
        tableHTML += '</tbody></table>'
        tableSection.innerHTML = tableHTML
        
        document.body.appendChild(tableSection)
        const tableImage = await renderContentToImage(tableSection)
        document.body.removeChild(tableSection)
        
        if (tableImage) {
          const imgWidth = contentWidth
          const imgHeight = (imgWidth * (reportData.key_metrics.length * 30 + 60)) / contentWidth
          if (yPosition + imgHeight > pageHeight - margin) {
            pdf.addPage()
            yPosition = margin
          }
          pdf.addImage(tableImage, 'PNG', margin, yPosition, imgWidth, imgHeight)
          yPosition += imgHeight + 5
        }
      }
      
      // 4. 图表
      if (reportData.charts && reportData.charts.length > 0) {
        for (const chart of reportData.charts) {
          // 检查是否需要新页面
          if (yPosition > pageHeight - 100) {
            pdf.addPage()
            yPosition = margin
          }
          
          // 图表标题
          pdf.setFontSize(14)
          pdf.setFont('helvetica', 'bold')
          pdf.text(chart.title || '图表', margin, yPosition)
          yPosition += 8
          
          // 生成图表图片
          const chartImage = await getChartImage(chart.option, `chart_${chart.title}`)
          if (chartImage) {
            // 计算图片尺寸（保持宽高比）
            const imgWidth = contentWidth
            const imgHeight = (imgWidth * 0.5) // 假设图表高度是宽度的一半
            
            // 检查是否需要新页面
            if (yPosition + imgHeight > pageHeight - margin) {
              pdf.addPage()
              yPosition = margin
            }
            
            pdf.addImage(chartImage, 'PNG', margin, yPosition, imgWidth, imgHeight)
            yPosition += imgHeight + 5
          }
        }
      }
      
      // 5. 文字解读（解析Markdown，渲染为图片以确保中文正确显示）
      if (reportData.insights) {
        const insightsText = reportData.insights.replace(/[🎯👥📦📊📄✅⚠️💡❌🔴🟡🟢]/g, '')
        
        // 解析Markdown表格
        const markdownTables = parseMarkdownTable(insightsText)
        let processedText = insightsText
        
        // 移除Markdown表格（稍后单独渲染）
        markdownTables.forEach(table => {
          const tableStart = processedText.indexOf('|', table.startLine > 0 ? processedText.split('\n').slice(0, table.startLine).join('\n').length : 0)
          if (tableStart !== -1) {
            const tableEnd = processedText.indexOf('\n\n', tableStart)
            if (tableEnd !== -1) {
              processedText = processedText.substring(0, tableStart) + processedText.substring(tableEnd)
            }
          }
        })
        
        // 渲染文本内容为图片
        const textSection = document.createElement('div')
        textSection.style.padding = '20px'
        textSection.style.fontFamily = 'Arial, "Microsoft YaHei", sans-serif'
        textSection.style.backgroundColor = '#ffffff'
        textSection.style.width = `${contentWidth}mm`
        textSection.style.fontSize = '14px'
        textSection.style.lineHeight = '1.6'
        textSection.style.color = '#333'
        
        // 将Markdown转换为HTML
        const htmlContent = processedText
          .split('\n')
          .map(line => {
            const trimmed = line.trim()
            if (trimmed.startsWith('#')) {
              const level = trimmed.match(/^#+/)[0].length
              const text = trimmed.replace(/^#+\s*/, '')
              return `<h${level} style="font-size: ${20 - level * 2}px; font-weight: bold; margin: 10px 0;">${text}</h${level}>`
            } else if (trimmed.startsWith('-') || trimmed.startsWith('*')) {
              const text = trimmed.replace(/^[-*]\s*/, '')
              return `<p style="margin: 5px 0; padding-left: 20px;">• ${text}</p>`
            } else if (trimmed) {
              return `<p style="margin: 5px 0;">${trimmed}</p>`
            }
            return '<br/>'
          })
          .join('')
        
        textSection.innerHTML = htmlContent
        document.body.appendChild(textSection)
        const textImage = await renderContentToImage(textSection)
        document.body.removeChild(textSection)
        
        if (textImage) {
          const imgWidth = contentWidth
          const imgHeight = (imgWidth * 400) / contentWidth // 估算高度
          if (yPosition + imgHeight > pageHeight - margin) {
            pdf.addPage()
            yPosition = margin
          }
          pdf.addImage(textImage, 'PNG', margin, yPosition, imgWidth, imgHeight)
          yPosition += imgHeight + 5
        }
        
        // 渲染Markdown表格
        for (const table of markdownTables) {
          if (yPosition > pageHeight - 100) {
            pdf.addPage()
            yPosition = margin
          }
          
          const tableSection = document.createElement('div')
          tableSection.style.padding = '20px'
          tableSection.style.fontFamily = 'Arial, "Microsoft YaHei", sans-serif'
          tableSection.style.backgroundColor = '#ffffff'
          
          let tableHTML = '<table style="width: 100%; border-collapse: collapse; font-size: 12px; margin: 10px 0;">'
          tableHTML += '<thead><tr style="background-color: #217346; color: white;">'
          table.headers.forEach(header => {
            tableHTML += `<th style="padding: 8px; text-align: left; border: 1px solid #ddd;">${header}</th>`
          })
          tableHTML += '</tr></thead><tbody>'
          
          table.rows.forEach((row, idx) => {
            const bgColor = idx % 2 === 0 ? '#f9f9f9' : '#ffffff'
            tableHTML += `<tr style="background-color: ${bgColor};">`
            row.forEach(cell => {
              tableHTML += `<td style="padding: 8px; border: 1px solid #ddd;">${cell}</td>`
            })
            tableHTML += '</tr>'
          })
          
          tableHTML += '</tbody></table>'
          tableSection.innerHTML = tableHTML
          
          document.body.appendChild(tableSection)
          const tableImage = await renderContentToImage(tableSection)
          document.body.removeChild(tableSection)
          
          if (tableImage) {
            const imgWidth = contentWidth
            const imgHeight = (imgWidth * (table.rows.length * 30 + 40)) / contentWidth
            if (yPosition + imgHeight > pageHeight - margin) {
              pdf.addPage()
              yPosition = margin
            }
            pdf.addImage(tableImage, 'PNG', margin, yPosition, imgWidth, imgHeight)
            yPosition += imgHeight + 5
          }
        }
      }
      
      pdf.save(`报表_${getUserDateForFilename()}.pdf`)
    } catch (error) {
      console.error('导出PDF失败:', error)
      alert('导出PDF失败: ' + error.message)
    }
  }
  
  // 旧的Word导出函数（已废弃）
  const handleExportWord_OLD = async () => {
    if (!reportData) return
    
    try {
      const children = []
      
      // 1. 标题
      children.push(
        new Paragraph({
          text: reportData.title || '企业级报表',
          heading: HeadingLevel.HEADING_1,
          spacing: { after: 400 }
        })
      )
      
      // 2. 生成时间
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `生成时间: ${getUserNowLabel()}`,
              color: '666666',
              size: 20
            })
          ],
          spacing: { after: 400 }
        })
      )
      
      // 3. 核心指标表格
      if (reportData.key_metrics && reportData.key_metrics.length > 0) {
        // 表格标题
        children.push(
          new Paragraph({
            text: '核心指标概览',
            heading: HeadingLevel.HEADING_2,
            spacing: { after: 200 }
          })
        )
        
        // 构建表格行
        const tableRows = [
          // 表头
          new TableRow({
            children: [
              new TableCell({
                children: [new Paragraph({ 
                  children: [new TextRun({ text: '指标名称', bold: true, color: 'FFFFFF' })]
                })],
                width: { size: 30, type: WidthType.PERCENTAGE },
                shading: { fill: '217346' }
              }),
              new TableCell({
                children: [new Paragraph({ 
                  children: [new TextRun({ text: '数值', bold: true, color: 'FFFFFF' })]
                })],
                width: { size: 25, type: WidthType.PERCENTAGE },
                shading: { fill: '217346' }
              }),
              new TableCell({
                children: [new Paragraph({ 
                  children: [new TextRun({ text: '说明', bold: true, color: 'FFFFFF' })]
                })],
                width: { size: 45, type: WidthType.PERCENTAGE },
                shading: { fill: '217346' }
              })
            ]
          })
        ]
        
        // 数据行
        for (const metric of reportData.key_metrics) {
          tableRows.push(
            new TableRow({
              children: [
                new TableCell({
                  children: [new Paragraph({ text: metric.name || '' })],
                  width: { size: 30, type: WidthType.PERCENTAGE }
                }),
                new TableCell({
                  children: [new Paragraph({ 
                    text: `${metric.value || ''}${metric.unit || ''}`,
                    alignment: AlignmentType.RIGHT
                  })],
                  width: { size: 25, type: WidthType.PERCENTAGE }
                }),
                new TableCell({
                  children: [new Paragraph({ text: metric.description || '' })],
                  width: { size: 45, type: WidthType.PERCENTAGE }
                })
              ]
            })
          )
        }
        
        children.push(
          new Table({
            rows: tableRows,
            width: { size: 100, type: WidthType.PERCENTAGE },
            margins: { top: 100, bottom: 100 }
          })
        )
        
        children.push(
          new Paragraph({
            text: '',
            spacing: { after: 400 }
          })
        )
      }
      
      // 4. 图表
      if (reportData.charts && reportData.charts.length > 0) {
        for (const chart of reportData.charts) {
          // 图表标题
          children.push(
            new Paragraph({
              text: chart.title || '图表',
              heading: HeadingLevel.HEADING_2,
              spacing: { after: 200 }
            })
          )
          
          // 生成图表图片
          const chartImage = await getChartImage(chart.option, `chart_${chart.title}`)
          if (chartImage) {
            try {
              const imageBuffer = base64ToArrayBuffer(chartImage)
              children.push(
                new Paragraph({
                  children: [
                    new ImageRun({
                      data: imageBuffer,
                      transformation: {
                        width: 600,
                        height: 300
                      }
                    })
                  ],
                  alignment: AlignmentType.CENTER,
                  spacing: { after: 400 }
                })
              )
            } catch (error) {
              console.error('添加图表图片失败:', error)
              children.push(
                new Paragraph({
                  text: `[图表: ${chart.title}]`,
                  spacing: { after: 200 }
                })
              )
            }
          }
        }
      }
      
      // 5. 文字解读（解析Markdown，包括表格）
      if (reportData.insights) {
        const insightsText = reportData.insights.replace(/[🎯👥📦📊📄✅⚠️💡❌🔴🟡🟢]/g, '')
        
        // 解析Markdown表格
        const markdownTables = parseMarkdownTable(insightsText)
        const tablePositions = new Map() // 记录表格在文本中的位置
        
        // 找到每个表格在原文中的位置
        const lines = insightsText.split('\n')
        let currentTableIndex = 0
        let inTable = false
        let tableStartLine = -1
        
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim()
          if (line.startsWith('|') && line.endsWith('|') && !line.match(/^[\s|:-]+$/)) {
            if (!inTable) {
              inTable = true
              tableStartLine = i
            }
          } else if (inTable && (line === '' || !line.startsWith('|'))) {
            if (currentTableIndex < markdownTables.length) {
              tablePositions.set(currentTableIndex, { start: tableStartLine, end: i })
              currentTableIndex++
            }
            inTable = false
          }
        }
        
        // 处理文本，将表格部分替换为占位符
        let processedLines = lines
        const tablePlaceholders = []
        
        markdownTables.forEach((table, idx) => {
          const pos = tablePositions.get(idx)
          if (pos) {
            const placeholder = `__TABLE_${idx}__`
            tablePlaceholders.push({ placeholder, table, startLine: pos.start, endLine: pos.end })
            // 移除表格行
            processedLines = [
              ...processedLines.slice(0, pos.start),
              placeholder,
              ...processedLines.slice(pos.end)
            ]
          }
        })
        
        // 处理文本内容
        for (let i = 0; i < processedLines.length; i++) {
          const line = processedLines[i]
          const trimmedLine = line.trim()
          
          // 检查是否是表格占位符
          const placeholderMatch = trimmedLine.match(/^__TABLE_(\d+)__$/)
          if (placeholderMatch) {
            const tableIdx = parseInt(placeholderMatch[1])
            const placeholder = tablePlaceholders.find(p => p.placeholder === trimmedLine)
            if (placeholder) {
              // 将Markdown表格转换为Word表格
              const tableRows = [
                // 表头
                new TableRow({
                  children: placeholder.table.headers.map(header =>
                    new TableCell({
                      children: [new Paragraph({
                        children: [new TextRun({ text: header, bold: true, color: 'FFFFFF' })]
                      })],
                      shading: { fill: '217346' }
                    })
                  )
                })
              ]
              
              // 数据行
              placeholder.table.rows.forEach(row => {
                tableRows.push(
                  new TableRow({
                    children: row.map(cell =>
                      new TableCell({
                        children: [new Paragraph({ text: cell })]
                      })
                    )
                  })
                )
              })
              
              children.push(
                new Table({
                  rows: tableRows,
                  width: { size: 100, type: WidthType.PERCENTAGE },
                  margins: { top: 100, bottom: 100 }
                })
              )
              
              children.push(
                new Paragraph({
                  text: '',
                  spacing: { after: 200 }
                })
              )
            }
            continue
          }
          
          // 处理标题
          if (trimmedLine.startsWith('#')) {
            const level = trimmedLine.match(/^#+/)[0].length
            const titleText = trimmedLine.replace(/^#+\s*/, '')
            const headingLevel = level === 1 ? HeadingLevel.HEADING_1 :
                                 level === 2 ? HeadingLevel.HEADING_2 :
                                 level === 3 ? HeadingLevel.HEADING_3 : HeadingLevel.HEADING_4
            
            children.push(
              new Paragraph({
                text: titleText,
                heading: headingLevel,
                spacing: { after: 200 }
              })
            )
            continue
          }
          
          // 处理列表
          if (trimmedLine.startsWith('-') || trimmedLine.startsWith('*')) {
            const listText = trimmedLine.replace(/^[-*]\s*/, '')
            children.push(
              new Paragraph({
                text: `• ${listText}`,
                spacing: { after: 100 },
                indent: { left: 400 }
              })
            )
            continue
          }
          
          // 处理普通文本
          if (trimmedLine) {
            children.push(
              new Paragraph({
                text: trimmedLine,
                spacing: { after: 150 }
              })
            )
          } else {
            // 空行
            children.push(
              new Paragraph({
                text: '',
                spacing: { after: 100 }
              })
            )
          }
        }
      }
      
      const doc = new Document({
        sections: [{
          children,
          properties: {
            page: {
              margin: {
                top: 1440, // 1 inch = 1440 twips
                right: 1440,
                bottom: 1440,
                left: 1440
              }
            }
          }
        }]
      })
      
      const blob = await Packer.toBlob(doc)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `报表_${getUserDateForFilename()}.docx`
      link.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      console.error('导出Word失败:', error)
      alert('导出Word失败: ' + error.message)
    }
  }
  
  // 旧的PNG导出函数（已废弃）
  const handleExportPNG_OLD = async () => {
    if (!reportContentRef.current) return
    
    try {
      const canvas = await html2canvas(reportContentRef.current, {
        scale: 4, // 提高分辨率，从2改为4
        useCORS: true,
        backgroundColor: '#ffffff',
        logging: false,
        windowWidth: reportContentRef.current.scrollWidth,
        windowHeight: reportContentRef.current.scrollHeight
      })
      
      const imgData = canvas.toDataURL('image/png', 1.0) // 最高质量
      const link = document.createElement('a')
      link.href = imgData
      link.download = `报表_${getUserDateForFilename()}.png`
      link.click()
    } catch (error) {
      console.error('导出PNG失败:', error)
      alert('导出PNG失败')
    }
  }

  if (!isOpen) return null

  return (
    <div className="report-modal-overlay" onClick={onClose}>
      <div className="report-modal" onClick={(e) => e.stopPropagation()}>
        <div className="report-modal-header">
          <h2>报表生成</h2>
          <button className="report-modal-close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        
        <div className="report-modal-content">
          {/* 文件信息 */}
          <div className="report-file-info">
            <div className="info-item">
              <span className="info-label">文件名:</span>
              <span className="info-value">{largeFileInfo?.original_name || '未知'}</span>
            </div>
            <div className="info-item">
              <span className="info-label">工作表数:</span>
              <span className="info-value">{largeFileInfo?.sheet_names?.length || 0}</span>
            </div>
            <div className="info-item">
              <span className="info-label">总行数:</span>
              <span className="info-value">{largeFileInfo?.row_count?.toLocaleString() || 0}</span>
            </div>
          </div>

          {/* 智能维度推荐 - 始终显示在上方 */}
          <div className="report-dimensions-section">
              <div className="dimensions-header">
                <h3>报表维度选择</h3>
                <button
                  className="btn-analyze"
                  onClick={handleAnalyzeDimensions}
                  disabled={analyzing}
                >
                  {analyzing ? (
                    <>
                      <Loader2 className="animate-spin" size={16} />
                      分析中...
                    </>
                  ) : (
                    <>
                      <Sparkles size={16} />
                      AI智能推荐
                    </>
                  )}
                </button>
              </div>

              {recommendedDimensions && (
                <div className="recommended-dimensions">
                  <div className="recommended-header">
                    <span className="business-type">
                      业务类型: {recommendedDimensions.business_type}
                    </span>
                  </div>
                  {recommendedDimensions.recommended_dimensions?.map((dim, idx) => (
                    <div
                      key={idx}
                      className={`dimension-card ${selectedDimensions === dim ? 'selected' : ''}`}
                      onClick={() => setSelectedDimensions(dim)}
                    >
                      <div className="dimension-title">推荐方案 {idx + 1}</div>
                      <div className="dimension-details">
                        {dim.time_dimension && (
                          <div className="dimension-item">
                            <span>时间维度:</span> {dim.time_dimension}
                          </div>
                        )}
                        {dim.category_dimensions && dim.category_dimensions.length > 0 && (
                          <div className="dimension-item">
                            <span>分类维度:</span> {dim.category_dimensions.join(', ')}
                          </div>
                        )}
                        {dim.statistics && dim.statistics.length > 0 && (
                          <div className="dimension-item">
                            <span>统计方式:</span> {dim.statistics.join(', ')}
                          </div>
                        )}
                        {dim.value_fields && dim.value_fields.length > 0 && (
                          <div className="dimension-item">
                            <span>数值字段:</span> {dim.value_fields.join(', ')}
                          </div>
                        )}
                      </div>
                      {dim.reasoning && (
                        <div className="dimension-reasoning">{dim.reasoning}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* 基础维度选择器 */}
              <div className="basic-dimensions-section">
                <h4>基础维度配置</h4>
                
                {/* 时间维度 */}
                {timeFields.length > 0 && (
                  <div className="dimension-group">
                    <label className="dimension-label">时间维度:</label>
                    <div className="dimension-options">
                      <select 
                        className="dimension-select"
                        value={timeDimension}
                        onChange={(e) => {
                          setTimeDimension(e.target.value)
                          if (e.target.value) {
                            const dim = selectedDimensions || {}
                            setSelectedDimensions({
                              ...dim,
                              time_field: e.target.value,
                              time_dimension: dim.time_dimension || '月'
                            })
                          }
                        }}
                      >
                        <option value="">-- 选择时间字段 --</option>
                        {timeFields.map(field => {
                          // 显示字段名（如果有工作表前缀，显示完整名称；否则只显示字段名）
                          const displayName = field.includes('.') ? field : field
                          return (
                            <option key={field} value={field}>{displayName}</option>
                          )
                        })}
                      </select>
                      {timeDimension && (
                        <select 
                          className="dimension-select"
                          value={selectedDimensions?.time_dimension || '月'}
                          onChange={(e) => {
                            const dim = selectedDimensions || {}
                            setSelectedDimensions({
                              ...dim,
                              time_dimension: e.target.value,
                              time_field: timeDimension
                            })
                          }}
                        >
                          <option value="年">年</option>
                          <option value="季度">季度</option>
                          <option value="月">月</option>
                          <option value="日">日</option>
                        </select>
                      )}
                    </div>
                  </div>
                )}

                {/* 分类维度 */}
                {categoryFields.length > 0 && (
                  <div className="dimension-group">
                    <label className="dimension-label">分类维度（可多选）:</label>
                    <div className="dimension-checkboxes">
                      {categoryFields.map(field => (
                        <label key={field} className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={categoryDimensions.includes(field)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setCategoryDimensions([...categoryDimensions, field])
                                const dim = selectedDimensions || {}
                                setSelectedDimensions({
                                  ...dim,
                                  category_dimensions: [...(dim.category_dimensions || []), field]
                                })
                              } else {
                                setCategoryDimensions(categoryDimensions.filter(f => f !== field))
                                const dim = selectedDimensions || {}
                                setSelectedDimensions({
                                  ...dim,
                                  category_dimensions: (dim.category_dimensions || []).filter(f => f !== field)
                                })
                              }
                            }}
                          />
                          <span>{field.includes('.') ? field : field}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {/* 统计维度 */}
                <div className="dimension-group">
                  <label className="dimension-label">统计方式（可多选）:</label>
                  <div className="dimension-checkboxes">
                    {['求和', '平均', '最大', '最小', '计数'].map(stat => (
                      <label key={stat} className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={statistics.includes(stat)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setStatistics([...statistics, stat])
                              const dim = selectedDimensions || {}
                              setSelectedDimensions({
                                ...dim,
                                statistics: [...(dim.statistics || []), stat]
                              })
                            } else {
                              setStatistics(statistics.filter(s => s !== stat))
                              const dim = selectedDimensions || {}
                              setSelectedDimensions({
                                ...dim,
                                statistics: (dim.statistics || []).filter(s => s !== stat)
                              })
                            }
                          }}
                        />
                        <span>{stat}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* 数值字段 */}
                {numericFields.length > 0 && (
                  <div className="dimension-group">
                    <label className="dimension-label">数值字段（可多选）:</label>
                    <div className="dimension-checkboxes">
                      {numericFields.map(field => {
                        // 显示字段名（如果有工作表前缀，显示完整名称）
                        const displayName = field.includes('.') ? field : field
                        return (
                          <label key={field} className="checkbox-label">
                            <input
                              type="checkbox"
                              checked={valueFields.includes(field)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setValueFields([...valueFields, field])
                                  const dim = selectedDimensions || {}
                                  setSelectedDimensions({
                                    ...dim,
                                    value_fields: [...(dim.value_fields || []), field]
                                  })
                                } else {
                                  setValueFields(valueFields.filter(f => f !== field))
                                  const dim = selectedDimensions || {}
                                  setSelectedDimensions({
                                    ...dim,
                                    value_fields: (dim.value_fields || []).filter(f => f !== field)
                                  })
                                }
                              }}
                            />
                            <span>{displayName}</span>
                          </label>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>

              <div className="report-actions">
                {/* 关联字段选择器（仅在多个工作表时显示） */}
                {(() => {
                  const selectedSheets = getSelectedSheets()
                  const needsJoinKey = selectedSheets.length > 1
                  
                  if (!needsJoinKey) return null
                  
                  return (
                    <div className="dimension-group" style={{ marginTop: '20px', padding: '15px', backgroundColor: '#fff3cd', border: '1px solid #ffc107', borderRadius: '4px' }}>
                      <label className="dimension-label" style={{ color: '#856404', fontWeight: 'bold', textAlign: 'left', display: 'block' }}>
                        ⚠️ 关联字段（必选）:
                      </label>
                      <div style={{ marginTop: '10px', fontSize: '14px', color: '#856404', marginBottom: '10px' }}>
                        您选择了多个工作表的字段，必须为每个工作表选择一个关联字段才能生成报表。
                        <br />
                        关联字段用于连接不同工作表的数据，避免产生大量无意义的数据组合。
                      </div>
                      
                      {/* 为每个涉及的工作表显示关联字段选择器 */}
                      {selectedSheets.map(sheet => {
                        const columns = sheetColumns[sheet] || []
                        const selectedJoinKey = joinKeys[sheet] || ''
                        const isRequired = selectedSheets.length > 1
                        
                        return (
                          <div key={sheet} style={{ marginBottom: '15px', display: 'block', width: '100%' }}>
                            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#856404', textAlign: 'left' }}>
                              {sheet} 的关联字段:
                            </label>
                            <select 
                              className="dimension-select"
                              value={selectedJoinKey}
                              onChange={(e) => {
                                setJoinKeys({
                                  ...joinKeys,
                                  [sheet]: e.target.value
                                })
                              }}
                              style={{ 
                                display: 'block',
                                width: '100%', 
                                maxWidth: '100%',
                                padding: '8px', 
                                border: selectedJoinKey ? '1px solid #28a745' : '1px solid #dc3545',
                                borderRadius: '4px',
                                textAlign: 'left'
                              }}
                            >
                              <option value="">-- 请选择 {sheet} 的关联字段（必选）--</option>
                              {columns.map(column => (
                                <option key={column} value={column}>{column}</option>
                              ))}
                            </select>
                            {selectedJoinKey ? (
                              <span style={{ color: '#28a745', fontSize: '14px', marginTop: '4px', display: 'block' }}>
                                ✓ 已选择：{selectedJoinKey}
                              </span>
                            ) : (
                              <span style={{ color: '#dc3545', fontSize: '14px', marginTop: '4px', display: 'block' }}>
                                ✗ 必须选择关联字段
                              </span>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )
                })()}

                <button
                  className="btn-generate"
                  onClick={handleGenerateReport}
                  disabled={(() => {
                    // 检查是否选择了维度
                    const hasDimensions = selectedDimensions || timeDimension || categoryDimensions.length > 0 || valueFields.length > 0
                    if (!hasDimensions) return true
                    
                    // 检查是否需要关联字段
                    const selectedSheets = getSelectedSheets()
                    if (selectedSheets.length > 1) {
                      // 检查是否所有工作表都选择了关联字段
                      const missingSheets = selectedSheets.filter(sheet => !joinKeys[sheet] || !joinKeys[sheet].trim())
                      if (missingSheets.length > 0) return true
                    }
                    
                    return generating
                  })()}
                >
                  {generating ? (
                    <>
                      <Loader2 className="animate-spin" size={16} />
                      生成中...
                    </>
                  ) : (
                    <>
                      <FileText size={16} />
                      生成报表
                    </>
                  )}
                </button>
                {reportData && (
                  <button
                    className="btn-reset"
                    onClick={() => {
                      setReportData(null)
                      setSelectedDimensions(null)
                      setTimeDimension('')
                      setCategoryDimensions([])
                      setValueFields([])
                      setStatistics(['求和'])
                    }}
                  >
                    重新生成
                  </button>
                )}
              </div>
            </div>

          {/* 生成中提示 */}
          {generating && !reportData && (
            <div className="report-generating">
              <Loader2 className="animate-spin" size={48} />
              <p>正在生成报表，请稍候...</p>
            </div>
          )}

          {/* 报表内容区域 - 动态加载在维度选择下方 */}
          {(reportData || generating) && (
            <div className="report-content-section fade-in">
              <div className="report-content" ref={reportContentRef}>
                {/* 标题和进度 */}
                {(reportData?.title || generating) && (
                  <div className="report-header">
                    <h1>{reportData?.title || '报表生成中...'}</h1>
                    <div className="report-meta">
                      {reportData?.progress && (
                        <div className="report-progress">
                          {reportData.progress}
                        </div>
                      )}
                      {reportData?.completed_at && (
                        <div>生成时间: {formatInUserTimezone(reportData.completed_at)}</div>
                      )}
                    </div>
                  </div>
                )}

                {/* 图表区域 - 动态加载 */}
                {reportData?.charts && reportData.charts.length > 0 && (
                  <div className="report-charts">
                    {reportData.charts.map((chart, idx) => (
                      <div key={idx} className="chart-container fade-in" style={{ animationDelay: `${idx * 0.2}s` }}>
                        <h3>{chart.title || `图表 ${idx + 1}`}</h3>
                        <ReactECharts
                          option={chart.option}
                          style={{ height: '400px', width: '100%' }}
                        />
                      </div>
                    ))}
                  </div>
                )}

                {/* 核心指标表格 - 动态加载 */}
                {reportData?.key_metrics && reportData.key_metrics.length > 0 && (
                  <div className="report-metrics-section fade-in">
                    <h2>核心指标概览</h2>
                    <div className="metrics-table-wrapper">
                      <table className="metrics-table">
                        <thead>
                          <tr>
                            <th>指标名称</th>
                            <th>数值</th>
                            <th>说明</th>
                          </tr>
                        </thead>
                        <tbody>
                          {reportData.key_metrics.map((metric, idx) => (
                            <tr key={idx}>
                              <td>{metric.name}</td>
                              <td className="metric-value">
                                {metric.value}{metric.unit}
                              </td>
                              <td>{metric.description}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* 指标对比图表 - 从key_metrics生成（按维度分组） */}
                {reportData?.key_metrics && reportData.key_metrics.length > 0 && (() => {
                  /**
                   * 图表生成规则（System Prompt）：
                   * 1. 禁止单个指标生成图表：如果只有一个指标，不生成图表
                   * 2. 禁止不同维度指标放在同一图表：只将数值量级相近（数量级差异<=1）的指标放在同一图表
                   * 3. 禁止出现不同维度的数据放在同一个图表中，对用户没有任何价值
                   *    - 不同单位、不同量级的指标必须分开显示
                   *    - 例如：订单总数量（笔）、销售额（元）、折扣率（%）不应放在同一图表
                   */
                  
                  // 计算数值的数量级（对数的整数部分）
                  const getMagnitude = (value) => {
                    if (value === 0) return 0
                    const absValue = Math.abs(value)
                    if (absValue < 1) {
                      return Math.floor(Math.log10(absValue))
                    }
                    return Math.floor(Math.log10(absValue))
                  }
                  
                  // 按维度分组指标（基于数值量级）
                  const groupMetricsByDimension = (metrics) => {
                    const groups = []
                    const processed = new Set()
                    
                    for (const metric of metrics) {
                      if (processed.has(metric)) continue
                      
                      const magnitude = getMagnitude(metric.numeric_value)
                      const group = [metric]
                      processed.add(metric)
                      
                      // 寻找相似量级的指标（数量级差异<=1）
                      for (const otherMetric of metrics) {
                        if (processed.has(otherMetric)) continue
                        
                        const otherMagnitude = getMagnitude(otherMetric.numeric_value)
                        const magnitudeDiff = Math.abs(magnitude - otherMagnitude)
                        
                        // 规则2和3：只将数量级差异<=1的指标放在同一组
                        if (magnitudeDiff <= 1) {
                          group.push(otherMetric)
                          processed.add(otherMetric)
                        }
                      }
                      
                      // 规则1：只保留包含至少2个指标的组
                      if (group.length >= 2) {
                        groups.push(group)
                      }
                    }
                    
                    return groups
                  }
                  
                  // 生成单个指标组的图表
                  const generateMetricsChart = (metrics) => {
                    if (metrics.length < 2) return null // 规则1：禁止单个指标生成图表
                    
                    // 按数值大小排序
                    const sortedMetrics = [...metrics].sort(
                      (a, b) => Math.abs(b.numeric_value) - Math.abs(a.numeric_value)
                    )
                    
                    // 生成图表标题（使用组内指标名称）
                    const chartTitle = sortedMetrics.length <= 3
                      ? sortedMetrics.map(m => m.name).join('、') + '对比'
                      : '同维度指标对比'
                    
                    return {
                      title: chartTitle,
                      type: "bar",
                      option: {
                        title: {
                          text: chartTitle,
                          left: "center",
                          textStyle: {
                            fontSize: 18,
                            fontWeight: "bold"
                          }
                        },
                        tooltip: {
                          trigger: "axis",
                          formatter: (params) => {
                            const param = params[0]
                            const metric = sortedMetrics[param.dataIndex]
                            return `${metric.name}<br/>${param.seriesName}: ${param.value}${metric.unit || ''}`
                          }
                        },
                        xAxis: {
                          type: "category",
                          data: sortedMetrics.map(m => m.name),
                          name: "指标名称",
                          nameLocation: "middle",
                          nameGap: 30,
                          axisLabel: {
                            rotate: 45,
                            interval: 0
                          }
                        },
                        yAxis: {
                          type: "value",
                          name: "数值",
                          nameLocation: "middle",
                          nameGap: 50
                        },
                        series: [{
                          name: "指标值",
                          data: sortedMetrics.map(m => m.numeric_value),
                          type: "bar",
                          itemStyle: {
                            color: "#217346"
                          },
                          label: {
                            show: true,
                            position: "top",
                            formatter: (params) => {
                              const metric = sortedMetrics[params.dataIndex]
                              return `${params.value}${metric.unit || ''}`
                            }
                          }
                        }]
                      }
                    }
                  }
                  
                  // 筛选出有数值的指标
                  const numericMetrics = reportData.key_metrics.filter(
                    m => m.numeric_value != null && m.numeric_value !== undefined
                  )
                  
                  if (numericMetrics.length === 0) return null
                  
                  // 按维度分组
                  const metricGroups = groupMetricsByDimension(numericMetrics)
                  
                  // 为每个组生成图表
                  return metricGroups.map((group, index) => {
                    const chart = generateMetricsChart(group)
                    if (!chart) return null
                    
                    return (
                      <div key={index} className="chart-container fade-in">
                        <h3>{chart.title}</h3>
                        <ReactECharts
                          option={chart.option}
                          style={{ height: '400px', width: '100%' }}
                        />
                      </div>
                    )
                  }).filter(Boolean)
                })()}

                {/* 文字解读 - 动态加载 */}
                {reportData?.insights && (() => {
                  // 解析Markdown文本中的所有表格（支持多种格式）
                  const parseMarkdownTables = (markdown) => {
                    const tables = []
                    let tableIndex = 0
                    
                    // 方法1：标准格式（表头和分隔行在不同行）
                    const standardTableRegex = /(\|[^\n]+\|\s*\n\|[\s-|:]+\|\s*\n(?:\|[^\n]+\|\s*\n?)+)/g
                    let match
                    
                    while ((match = standardTableRegex.exec(markdown)) !== null) {
                      const tableText = match[1]
                      const parsed = parseTableText(tableText, tableIndex++)
                      if (parsed) tables.push(parsed)
                    }
                    
                    // 方法2：紧凑格式（表头和分隔行在同一行）：| 列1 | 列2 | |---|---|
                    const compactTableRegex = /(\|[^\n]+\|\s*\|\s*[\s-|:]+\|(?:\s*\n\s*\|\s*[^\n]+\|)+)/g
                    standardTableRegex.lastIndex = 0 // 重置
                    
                    while ((match = compactTableRegex.exec(markdown)) !== null) {
                      const tableText = match[1]
                      // 检查是否已经被标准格式匹配过
                      const alreadyParsed = tables.some(t => t.rawText === tableText)
                      if (!alreadyParsed) {
                        // 将紧凑格式转换为标准格式
                        const normalized = normalizeCompactTable(tableText)
                        const parsed = parseTableText(normalized, tableIndex++)
                        if (parsed) tables.push(parsed)
                      }
                    }
                    
                    // 方法3：逐行检测（更宽松的匹配）
                    const lines = markdown.split('\n')
                    let currentTable = null
                    let headerLine = null
                    let separatorLine = null
                    
                    for (let i = 0; i < lines.length; i++) {
                      const line = lines[i].trim()
                      
                      // 检测表头行
                      if (line.startsWith('|') && line.endsWith('|') && !line.match(/^[\s|:-]+$/)) {
                        // 检查下一行是否是分隔行
                        const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : ''
                        const isSeparator = nextLine.match(/^[\s|:-]+$/)
                        
                        if (isSeparator) {
                          // 标准格式：表头行 + 分隔行
                          headerLine = line
                          separatorLine = nextLine
                          currentTable = {
                            headerLine,
                            separatorLine,
                            dataLines: [],
                            startIndex: i
                          }
                          i++ // 跳过分隔行
                        } else {
                          // 可能是紧凑格式或数据行
                          if (currentTable) {
                            currentTable.dataLines.push(line)
                          } else {
                            // 检查是否是紧凑格式的表头+分隔行
                            const parts = line.split(/\s*\|\s*\|/).filter(p => p.trim())
                            if (parts.length >= 2) {
                              const headerPart = parts[0] + '|'
                              const separatorPart = '|' + parts[1]
                              if (separatorPart.match(/[\s-|:]+/)) {
                                headerLine = headerPart
                                separatorLine = separatorPart
                                currentTable = {
                                  headerLine,
                                  separatorLine,
                                  dataLines: [],
                                  startIndex: i
                                }
                              }
                            }
                          }
                        }
                      } else if (currentTable && line.startsWith('|') && line.endsWith('|')) {
                        // 数据行
                        currentTable.dataLines.push(line)
                      } else if (currentTable && (line === '' || !line.startsWith('|'))) {
                        // 表格结束
                        const tableText = [currentTable.headerLine, currentTable.separatorLine, ...currentTable.dataLines].join('\n')
                        const parsed = parseTableText(tableText, tableIndex++)
                        if (parsed) tables.push(parsed)
                        currentTable = null
                      }
                    }
                    
                    // 处理最后一个表格
                    if (currentTable && currentTable.dataLines.length > 0) {
                      const tableText = [currentTable.headerLine, currentTable.separatorLine, ...currentTable.dataLines].join('\n')
                      const parsed = parseTableText(tableText, tableIndex++)
                      if (parsed) tables.push(parsed)
                    }
                    
                    // 去重（基于表头）
                    const uniqueTables = []
                    const seenHeaders = new Set()
                    tables.forEach(table => {
                      const headerKey = table.headers.join('|')
                      if (!seenHeaders.has(headerKey)) {
                        seenHeaders.add(headerKey)
                        uniqueTables.push(table)
                      }
                    })
                    
                    return uniqueTables
                  }
                  
                  // 辅助函数：解析表格文本
                  const parseTableText = (tableText, index) => {
                    const lines = tableText.split('\n').filter(line => {
                      const trimmed = line.trim()
                      return trimmed.startsWith('|') && trimmed.endsWith('|')
                    })
                    
                    if (lines.length < 2) return null
                    
                    // 解析表头（第一行）
                    const headers = lines[0].split('|').map(h => h.trim()).filter(h => h && !h.match(/^[\s-:]+$/))
                    if (headers.length === 0) return null
                    
                    // 跳过分隔行（第二行），解析数据行
                    const dataLines = lines.slice(2).filter(line => {
                      const trimmed = line.trim()
                      return !trimmed.match(/^[\s|:-]+$/)
                    })
                    
                    const rows = dataLines.map(row => {
                      const cells = row.split('|').map(c => c.trim()).filter(c => c)
                      const obj = {}
                      headers.forEach((header, idx) => {
                        obj[header] = cells[idx] || ''
                      })
                      return obj
                    }).filter(row => {
                      return Object.values(row).some(val => val && val.trim())
                    })
                    
                    if (rows.length === 0) return null
                    
                    return {
                      index,
                      headers,
                      rows,
                      rawText: tableText
                    }
                  }
                  
                  // 辅助函数：规范化紧凑格式表格
                  const normalizeCompactTable = (compactText) => {
                    // 处理格式：| 列1 | 列2 | |---|---| 或 | 列1 | 列2 | |---------|------|
                    const lines = compactText.split('\n')
                    const firstLine = lines[0].trim()
                    
                    // 查找分隔符位置（可能是 | | 或 | |---|）
                    const separatorMatch = firstLine.match(/\|\s*\|[\s-|:]+\|/)
                    if (separatorMatch) {
                      const separatorIndex = separatorMatch.index
                      const headerPart = firstLine.substring(0, separatorIndex + 1)
                      const separatorPart = firstLine.substring(separatorIndex + 1)
                      
                      // 重新组合为标准格式
                      return [headerPart, separatorPart, ...lines.slice(1)].join('\n')
                    }
                    
                    // 尝试另一种格式：表头和分隔行在同一行但用空格分隔
                    const doublePipeMatch = firstLine.match(/\|\s*[^|]+\|\s*\|\s*[\s-|:]+\|/)
                    if (doublePipeMatch) {
                      const parts = firstLine.split(/\s*\|\s*\|/).filter(p => p.trim())
                      if (parts.length >= 2) {
                        const headerPart = '|' + parts[0] + '|'
                        const separatorPart = '|' + parts[1] + '|'
                        return [headerPart, separatorPart, ...lines.slice(1)].join('\n')
                      }
                    }
                    
                    return compactText
                  }
                  
                  // 识别表格类型并生成图表
                  const generateChartFromTable = (table) => {
                    const { headers, rows } = table
                    if (rows.length === 0) return null
                    
                    // 识别数值列
                    const numericColumns = headers.filter(header => {
                      return rows.some(row => {
                        const value = row[header]
                        if (!value) return false
                        // 尝试解析数值（去除单位）
                        const numStr = String(value).replace(/[^\d.-]/g, '')
                        return !isNaN(parseFloat(numStr)) && isFinite(parseFloat(numStr))
                      })
                    })
                    
                    if (numericColumns.length === 0) return null
                    
                    // 识别分类列（非数值列）
                    const categoryColumns = headers.filter(h => !numericColumns.includes(h))
                    
                    // 根据表格结构选择图表类型
                    let chartType = 'bar'
                    let chartData = null
                    let chartTitle = '数据可视化'
                    
                    // 情况1：有分类列 + 多个数值列 -> 分组柱状图
                    if (categoryColumns.length > 0 && numericColumns.length > 1) {
                      const categoryCol = categoryColumns[0]
                      chartTitle = `${categoryCol}对比分析`
                      chartType = 'bar'
                      
                      const categories = rows.map(row => row[categoryCol])
                      const series = numericColumns.map(col => ({
                        name: col,
                        data: rows.map(row => {
                          const val = row[col]
                          const numStr = String(val).replace(/[^\d.-]/g, '')
                          return parseFloat(numStr) || 0
                        }),
                        type: 'bar'
                      }))
                      
                      chartData = {
                        title: chartTitle,
                        type: chartType,
                        option: {
                          title: {
                            text: chartTitle,
                            left: 'center',
                            textStyle: { fontSize: 18, fontWeight: 'bold' }
                          },
                          tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
                          legend: { data: numericColumns, top: 30 },
                          grid: { left: '3%', right: '4%', bottom: '3%', containLabel: true },
                          xAxis: {
                            type: 'category',
                            data: categories,
                            name: categoryCol,
                            nameLocation: 'middle',
                            nameGap: 30,
                            axisLabel: { rotate: 45 }
                          },
                          yAxis: {
                            type: 'value',
                            name: '数值',
                            nameLocation: 'middle',
                            nameGap: 50
                          },
                          series
                        }
                      }
                    }
                    // 情况2：有分类列 + 单个数值列 -> 根据数据特点选择图表类型
                    else if (categoryColumns.length > 0 && numericColumns.length === 1) {
                      const categoryCol = categoryColumns[0]
                      const valueCol = numericColumns[0]
                      
                      const data = rows.map(row => ({
                        name: row[categoryCol],
                        value: parseFloat(String(row[valueCol]).replace(/[^\d.-]/g, '')) || 0
                      })).filter(d => d.value > 0) // 过滤零值
                      
                      // 根据分类数量和数值特点选择图表类型
                      if (data.length <= 5 && data.length > 0) {
                        // 分类少 -> 饼图
                        chartTitle = `${categoryCol}分布`
                        chartType = 'pie'
                        chartData = {
                          title: chartTitle,
                          type: chartType,
                          option: {
                            title: {
                              text: chartTitle,
                              left: 'center',
                              textStyle: { fontSize: 18, fontWeight: 'bold' }
                            },
                            tooltip: { trigger: 'item', formatter: '{a} <br/>{b}: {c} ({d}%)' },
                            legend: { orient: 'vertical', left: 'left' },
                            series: [{
                              name: valueCol,
                              type: 'pie',
                              radius: '50%',
                              data,
                              emphasis: {
                                itemStyle: {
                                  shadowBlur: 10,
                                  shadowOffsetX: 0,
                                  shadowColor: 'rgba(0, 0, 0, 0.5)'
                                }
                              }
                            }]
                          }
                        }
                      } else if (data.length > 5 && data.length <= 15) {
                        // 分类中等 -> 柱状图
                        chartTitle = `${categoryCol}对比`
                        chartType = 'bar'
                        chartData = {
                          title: chartTitle,
                          type: chartType,
                          option: {
                            title: {
                              text: chartTitle,
                              left: 'center',
                              textStyle: { fontSize: 18, fontWeight: 'bold' }
                            },
                            tooltip: { trigger: 'axis' },
                            xAxis: {
                              type: 'category',
                              data: data.map(d => d.name),
                              name: categoryCol,
                              nameLocation: 'middle',
                              nameGap: 30,
                              axisLabel: { rotate: 45, interval: 0 }
                            },
                            yAxis: {
                              type: 'value',
                              name: valueCol,
                              nameLocation: 'middle',
                              nameGap: 50
                            },
                            series: [{
                              name: valueCol,
                              data: data.map(d => d.value),
                              type: 'bar',
                              itemStyle: { color: '#217346' },
                              label: {
                                show: true,
                                position: 'top'
                              }
                            }]
                          }
                        }
                      } else {
                        // 分类多 -> 横向柱状图
                        chartTitle = `${categoryCol}对比`
                        chartType = 'bar'
                        chartData = {
                          title: chartTitle,
                          type: chartType,
                          option: {
                            title: {
                              text: chartTitle,
                              left: 'center',
                              textStyle: { fontSize: 18, fontWeight: 'bold' }
                            },
                            tooltip: { trigger: 'axis' },
                            grid: { left: '20%', right: '10%' },
                            xAxis: {
                              type: 'value',
                              name: valueCol,
                              nameLocation: 'middle',
                              nameGap: 30
                            },
                            yAxis: {
                              type: 'category',
                              data: data.map(d => d.name),
                              name: categoryCol,
                              nameLocation: 'middle',
                              nameGap: 50,
                              axisLabel: { interval: 0 }
                            },
                            series: [{
                              name: valueCol,
                              data: data.map(d => d.value),
                              type: 'bar',
                              itemStyle: { color: '#217346' }
                            }]
                          }
                        }
                      }
                    }
                    // 情况3：只有数值列 -> 根据数值列数量选择图表类型
                    else if (categoryColumns.length === 0 && numericColumns.length > 0) {
                      if (numericColumns.length === 1) {
                        // 单个数值列 -> 折线图
                        const valueCol = numericColumns[0]
                        chartTitle = `${valueCol}趋势`
                        chartType = 'line'
                        
                        const data = rows.map((row, idx) => ({
                          name: `项目${idx + 1}`,
                          value: parseFloat(String(row[valueCol]).replace(/[^\d.-]/g, '')) || 0
                        }))
                        
                        chartData = {
                          title: chartTitle,
                          type: chartType,
                          option: {
                            title: {
                              text: chartTitle,
                              left: 'center',
                              textStyle: { fontSize: 18, fontWeight: 'bold' }
                            },
                            tooltip: { trigger: 'axis' },
                            xAxis: {
                              type: 'category',
                              data: data.map(d => d.name),
                              name: '序号',
                              nameLocation: 'middle',
                              nameGap: 30
                            },
                            yAxis: {
                              type: 'value',
                              name: valueCol,
                              nameLocation: 'middle',
                              nameGap: 50
                            },
                            series: [{
                              name: valueCol,
                              data: data.map(d => d.value),
                              type: 'line',
                              smooth: true,
                              itemStyle: { color: '#217346' },
                              areaStyle: {
                                color: {
                                  type: 'linear',
                                  x: 0,
                                  y: 0,
                                  x2: 0,
                                  y2: 1,
                                  colorStops: [
                                    { offset: 0, color: 'rgba(33, 115, 70, 0.3)' },
                                    { offset: 1, color: 'rgba(33, 115, 70, 0.1)' }
                                  ]
                                }
                              }
                            }]
                          }
                        }
                      } else {
                        // 多个数值列 -> 折线图（多条线）
                        chartTitle = '多指标趋势对比'
                        chartType = 'line'
                        
                        const categories = rows.map((row, idx) => `项目${idx + 1}`)
                        const series = numericColumns.map(col => ({
                          name: col,
                          data: rows.map(row => {
                            const val = row[col]
                            const numStr = String(val).replace(/[^\d.-]/g, '')
                            return parseFloat(numStr) || 0
                          }),
                          type: 'line',
                          smooth: true
                        }))
                        
                        chartData = {
                          title: chartTitle,
                          type: chartType,
                          option: {
                            title: {
                              text: chartTitle,
                              left: 'center',
                              textStyle: { fontSize: 18, fontWeight: 'bold' }
                            },
                            tooltip: { trigger: 'axis' },
                            legend: { data: numericColumns, top: 30 },
                            grid: { left: '3%', right: '4%', bottom: '3%', containLabel: true },
                            xAxis: {
                              type: 'category',
                              data: categories,
                              name: '序号',
                              nameLocation: 'middle',
                              nameGap: 30
                            },
                            yAxis: {
                              type: 'value',
                              name: '数值',
                              nameLocation: 'middle',
                              nameGap: 50
                            },
                            series
                          }
                        }
                      }
                    }
                    
                    return chartData
                  }
                  
                  const insightsText = reportData.insights.replace(/[🎯👥📦📊📄✅⚠️💡❌🔴🟡🟢]/g, '')
                  const parsedTables = parseMarkdownTables(insightsText)
                  
                  // 为每个表格生成图表
                  const tableChartsMap = new Map()
                  parsedTables.forEach((table) => {
                    const chart = generateChartFromTable(table)
                    if (chart) {
                      tableChartsMap.set(table.index, chart)
                    }
                  })
                  
                  // 预处理Markdown：将表格替换为带图表的自定义标记
                  let processedText = insightsText
                  const tablePlaceholders = []
                  
                  parsedTables.forEach((table) => {
                    const chart = tableChartsMap.get(table.index)
                    const placeholder = `__TABLE_WITH_CHART_${table.index}__`
                    tablePlaceholders.push({
                      placeholder,
                      table,
                      chart
                    })
                    // 替换表格文本为占位符
                    processedText = processedText.replace(table.rawText, placeholder)
                  })
                  
                  return (
                    <div className="report-insights fade-in">
                      <h2>数据分析解读</h2>
                      
                      <div className="insights-content">
                        {processedText.split(/(__TABLE_WITH_CHART_\d+__)/).map((part, idx) => {
                          const placeholderMatch = part.match(/__TABLE_WITH_CHART_(\d+)__/)
                          if (placeholderMatch) {
                            const tableIndex = parseInt(placeholderMatch[1])
                            const placeholder = tablePlaceholders.find(p => p.table.index === tableIndex)
                            if (placeholder) {
                              const { table, chart } = placeholder
                              return (
                                <div key={`table-${tableIndex}`} className="table-with-chart-wrapper">
                                  {chart && (
                                    <div className="table-chart-above fade-in">
                                      <h4 className="table-chart-title">{chart.title}</h4>
                                      <ReactECharts
                                        option={chart.option}
                                        style={{ height: '350px', width: '100%' }}
                                      />
                                    </div>
                                  )}
                                  <div className="markdown-table-wrapper">
                                    <table className="markdown-table">
                                      <thead className="markdown-thead">
                                        <tr className="markdown-tr">
                                          {table.headers.map((header, hIdx) => (
                                            <th key={hIdx} className="markdown-th">{header}</th>
                                          ))}
                                        </tr>
                                      </thead>
                                      <tbody className="markdown-tbody">
                                        {table.rows.map((row, rIdx) => (
                                          <tr key={rIdx} className="markdown-tr">
                                            {table.headers.map((header, hIdx) => (
                                              <td key={hIdx} className="markdown-td">{row[header] || ''}</td>
                                            ))}
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              )
                            }
                            return null
                          }
                          
                          // 普通文本内容，使用ReactMarkdown渲染
                          if (part.trim()) {
                            return (
                              <ReactMarkdown
                                key={`text-${idx}`}
                                components={{
                                  h1: ({ children }) => <h1 className="markdown-h1">{children}</h1>,
                                  h2: ({ children }) => <h2 className="markdown-h2">{children}</h2>,
                                  h3: ({ children }) => <h3 className="markdown-h3">{children}</h3>,
                                  h4: ({ children }) => <h4 className="markdown-h4">{children}</h4>,
                                  ul: ({ children }) => <ul className="markdown-ul">{children}</ul>,
                                  ol: ({ children }) => <ol className="markdown-ol">{children}</ol>,
                                  li: ({ children }) => <li className="markdown-li">{children}</li>,
                                  p: ({ children }) => <p className="markdown-p">{children}</p>,
                                  strong: ({ children }) => <strong className="markdown-strong">{children}</strong>
                                }}
                              >
                                {part}
                              </ReactMarkdown>
                            )
                          }
                          return null
                        })}
                      </div>
                    </div>
                  )
                })()}

                {/* 下载按钮 - 仅在报表完成时显示 */}
                {reportData?.status === 'completed' && (
                  <div className="report-downloads fade-in">
                    <button 
                      className={`btn-download ${exportingPDF ? 'disabled' : ''}`} 
                      onClick={handleExportPDF}
                      disabled={exportingPDF}
                    >
                      {exportingPDF ? (
                        <>
                          <Loader2 size={16} className="animate-spin" />
                          正在导出中...
                        </>
                      ) : (
                        <>
                          <Download size={16} />
                          导出PDF
                        </>
                      )}
                    </button>
                    <button 
                      className={`btn-download ${exportingPNG ? 'disabled' : ''}`} 
                      onClick={handleExportPNG}
                      disabled={exportingPNG}
                    >
                      {exportingPNG ? (
                        <>
                          <Loader2 size={16} className="animate-spin" />
                          正在导出中...
                        </>
                      ) : (
                        <>
                          <Download size={16} />
                          导出PNG
                        </>
                      )}
                    </button>
                  </div>
                )}

                {/* 加载指示器 - 显示在底部，提示还有内容正在生成 */}
                {(generating || (reportData && reportData.status !== 'completed' && reportData.status !== 'failed')) && (
                  <div className="report-loading-indicator fade-in">
                    <Loader2 className="animate-spin" size={24} />
                    <span className="loading-text">
                      {(() => {
                        // 根据当前状态显示不同的提示文字
                        if (reportData?.charts && reportData.charts.length > 0 && !reportData?.insights) {
                          return '正在生成数据解读...'
                        } else if (reportData?.title && (!reportData?.charts || reportData.charts.length === 0)) {
                          return '正在生成图表...'
                        } else if (reportData?.progress) {
                          return reportData.progress
                        } else if (reportData?.title) {
                          return '正在生成报表内容...'
                        } else {
                          return '正在初始化报表...'
                        }
                      })()}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default ReportGenerator
