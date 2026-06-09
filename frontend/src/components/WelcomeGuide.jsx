// frontend/src/components/WelcomeGuide.jsx
/**
 * ===================================
 * 新手引导组件 - 逐步引导
 * - 通过小tips在功能位置提示
 * - 通过[下一步]跳转到下一个tips
 * - 根据模式（普通模式/大Excel模式）显示不同的引导步骤
 * ===================================
 */
import React, { useState, useEffect, useRef } from 'react'
import { X, ChevronRight, ChevronLeft, SkipForward, Sparkles } from 'lucide-react'

const STORAGE_KEY_NORMAL = 'excel_ai_welcome_tour_normal_completed'
const STORAGE_KEY_LARGE = 'excel_ai_welcome_tour_large_completed'

// 普通模式的引导步骤
const NORMAL_MODE_STEPS = [
  {
    id: 'ai-assistant',
    target: '[data-tour="ai-assistant"]',
    title: 'AI 智能助手',
    content: '这里是 AI 助手窗口，您可以通过自然语言与 AI 对话，自动完成 Excel 操作。例如："创建数据透视表，行字段：产品，值字段：销售额"',
    position: 'left', // left, right, top, bottom
    offset: { x: 20, y: 0 }
  },
  {
    id: 'toolbar',
    target: '[data-tour="toolbar"]',
    title: '工具栏',
    content: '工具栏提供了常用的 Excel 操作功能，包括文件操作、编辑、格式设置、数据操作等。',
    position: 'bottom',
    offset: { x: 0, y: 10 }
  },
  {
    id: 'formula-bar',
    target: '[data-tour="formula-bar"]',
    title: '公式栏',
    content: '公式栏显示当前选中单元格的内容和公式。您可以在这里编辑单元格的值或公式。',
    position: 'bottom',
    offset: { x: 0, y: 10 }
  },
  {
    id: 'excel-editor',
    target: '[data-tour="excel-editor"]',
    title: 'Excel 表格',
    content: '这是主要的编辑区域，您可以在这里编辑单元格、选择区域、查看数据。AI 的操作结果会实时显示在这里。',
    position: 'top',
    offset: { x: 0, y: -10 }
  },
  {
    id: 'sheet-tabs',
    target: '[data-tour="sheet-tabs"]',
    title: '工作表标签',
    content: '这里显示所有工作表标签。您可以点击切换工作表，右键可以重命名或删除工作表。AI 创建的新工作表会自动显示在这里。',
    position: 'top',
    offset: { x: 0, y: -10 }
  }
]

// 大Excel模式的引导步骤
const LARGE_MODE_STEPS = [
  {
    id: 'large-file-upload',
    target: '[data-tour="large-file-upload"]',
    title: '大文件上传',
    content: '点击这里上传大型 Excel 文件（>50MB）。上传后系统会自动加载到内存数据库，支持高效的数据分析。',
    position: 'bottom',
    offset: { x: 0, y: 10 }
  },
  {
    id: 'file-selector',
    target: '[data-tour="file-selector"]',
    title: '文件选择器',
    content: '这里显示已上传的大文件列表。您可以切换不同的文件进行分析。',
    position: 'bottom',
    offset: { x: 0, y: 10 }
  },
  {
    id: 'ai-assistant-large',
    target: '[data-tour="ai-assistant"]',
    title: 'AI 智能查询',
    content: '在大文件模式下，您可以通过自然语言查询数据。例如："按产品分组统计销售额"。AI 会自动生成 SQL 查询并返回结果。',
    position: 'left',
    offset: { x: 20, y: 0 }
  },
  {
    id: 'result-files',
    target: '[data-tour="result-files"]',
    title: '结果文件',
    content: '分析结果会自动保存为独立的 Excel 文件。您可以在这里预览和下载结果文件。',
    position: 'bottom',
    offset: { x: 0, y: 10 }
  },
  {
    id: 'preview-area',
    target: '[data-tour="excel-editor"]',
    title: '数据预览',
    content: '这里显示大文件的预览数据（前500行）。完整数据存储在内存数据库中，通过 AI 查询可以获取完整结果。',
    position: 'top',
    offset: { x: 0, y: -10 }
  }
]

function WelcomeGuide({ mode = 'normal' }) {
  const [currentStep, setCurrentStep] = useState(0)
  const [isVisible, setIsVisible] = useState(false)
  const [targetElement, setTargetElement] = useState(null)
  const [tooltipPosition, setTooltipPosition] = useState({ top: 0, left: 0 })
  const overlayRef = useRef(null)
  const tooltipRef = useRef(null)

  const steps = mode === 'large' ? LARGE_MODE_STEPS : NORMAL_MODE_STEPS
  const storageKey = mode === 'large' ? STORAGE_KEY_LARGE : STORAGE_KEY_NORMAL

  useEffect(() => {
    // 检查是否已经完成引导
    const hasCompleted = localStorage.getItem(storageKey) === 'true'
    if (!hasCompleted) {
      setIsVisible(true)
      // 延迟一下，确保DOM已渲染
      setTimeout(() => {
        updateTargetElement(0)
      }, 100)
    }
  }, [mode, storageKey])

  useEffect(() => {
    if (isVisible && currentStep < steps.length) {
      updateTargetElement(currentStep)
    }
  }, [currentStep, isVisible, steps.length])

  const updateTargetElement = (stepIndex) => {
    const step = steps[stepIndex]
    if (!step) return

    // 查找目标元素
    const element = document.querySelector(step.target)
    if (!element) {
      console.warn(`Tour target not found: ${step.target}`)
      // 如果找不到元素，尝试下一步
      if (stepIndex < steps.length - 1) {
        setTimeout(() => updateTargetElement(stepIndex + 1), 500)
      }
      return
    }

    setTargetElement(element)

    // 滚动到目标元素
    element.scrollIntoView({ behavior: 'smooth', block: 'center' })

    // 计算提示框位置
    setTimeout(() => {
      const rect = element.getBoundingClientRect()
      const tooltipRect = tooltipRef.current?.getBoundingClientRect()
      const tooltipWidth = tooltipRect?.width || 320
      const tooltipHeight = tooltipRect?.height || 200

      let top = 0
      let left = 0

      switch (step.position) {
        case 'right':
          top = rect.top + rect.height / 2 - tooltipHeight / 2
          left = rect.right + step.offset.x
          break
        case 'left':
          top = rect.top + rect.height / 2 - tooltipHeight / 2
          left = rect.left - tooltipWidth - step.offset.x
          break
        case 'top':
          top = rect.top - tooltipHeight - step.offset.y
          left = rect.left + rect.width / 2 - tooltipWidth / 2
          break
        case 'bottom':
        default:
          top = rect.bottom + step.offset.y
          left = rect.left + rect.width / 2 - tooltipWidth / 2
          break
      }

      // 确保提示框在视口内
      const padding = 20
      if (top < padding) top = padding
      if (left < padding) left = padding
      if (top + tooltipHeight > window.innerHeight - padding) {
        top = window.innerHeight - tooltipHeight - padding
      }
      if (left + tooltipWidth > window.innerWidth - padding) {
        left = window.innerWidth - tooltipWidth - padding
      }

      setTooltipPosition({ top, left })
    }, 100)
  }

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1)
    } else {
      handleComplete()
    }
  }

  const handlePrevious = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1)
    }
  }

  const handleSkip = () => {
    handleComplete()
  }

  const handleComplete = () => {
    setIsVisible(false)
    localStorage.setItem(storageKey, 'true')
  }

  if (!isVisible || currentStep >= steps.length) {
    return null
  }

  const step = steps[currentStep]
  const isFirstStep = currentStep === 0
  const isLastStep = currentStep === steps.length - 1

  return (
    <>
      {/* 遮罩层 */}
      <div
        ref={overlayRef}
        className="fixed inset-0 bg-black/60 z-[9998]"
        onClick={(e) => {
          // 点击遮罩层不关闭，必须点击按钮
          e.stopPropagation()
        }}
      />

      {/* 高亮目标元素 */}
      {targetElement && (
        <div
          className="fixed z-[9999] pointer-events-none"
          style={{
            top: targetElement.getBoundingClientRect().top - 4,
            left: targetElement.getBoundingClientRect().left - 4,
            width: targetElement.getBoundingClientRect().width + 8,
            height: targetElement.getBoundingClientRect().height + 8,
            border: '3px solid #3b82f6',
            borderRadius: '8px',
            boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.5), 0 0 20px rgba(59, 130, 246, 0.5)',
            transition: 'all 0.3s ease'
          }}
        />
      )}

      {/* 提示卡片 */}
      <div
        ref={tooltipRef}
        className="fixed z-[10000] bg-white rounded-lg shadow-2xl max-w-sm w-80 p-5 welcome-guide-tooltip"
        style={{
          top: `${tooltipPosition.top}px`,
          left: `${tooltipPosition.left}px`
        }}
      >
        {/* 步骤指示器 */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="bg-blue-100 p-1.5 rounded-lg">
              <Sparkles className="w-4 h-4 text-blue-600" />
            </div>
            <span className="text-xs text-gray-500 font-medium">
              步骤 {currentStep + 1} / {steps.length}
            </span>
          </div>
          <button
            onClick={handleSkip}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            aria-label="跳过"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 标题 */}
        <h3 className="text-lg font-semibold text-gray-800 mb-2">{step.title}</h3>

        {/* 内容 */}
        <p className="text-sm text-gray-600 leading-relaxed mb-4">{step.content}</p>

        {/* 按钮组 */}
        <div className="flex items-center justify-between gap-2 pt-3 border-t border-gray-200">
          <div className="flex gap-2">
            {!isFirstStep && (
              <button
                onClick={handlePrevious}
                className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
                上一步
              </button>
            )}
            <button
              onClick={handleSkip}
              className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded transition-colors"
            >
              <SkipForward className="w-4 h-4" />
              跳过
            </button>
          </div>
          <button
            onClick={handleNext}
            className="flex items-center gap-1 px-4 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 transition-colors font-medium"
          >
            {isLastStep ? '完成' : '下一步'}
            {!isLastStep && <ChevronRight className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </>
  )
}

export default WelcomeGuide
