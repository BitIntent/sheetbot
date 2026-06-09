// frontend/src/components/presentation/TemplateGallery.jsx
/**
 * ============================================================================
 * PPTX 模板选择画廊 — 2x5 网格展示 10 套模板
 * ============================================================================
 */
import React, { useMemo, useState } from 'react'
import {
  Briefcase, Monitor, FileText, TreePine, Flame,
  Building2, Award, Sparkles, GraduationCap, Crown,
  Loader2, Wand2,
} from 'lucide-react'
import { PPTIST_TEMPLATE_OPTIONS } from '../../constants/pptistTemplateOptions'

const ICON_MAP = {
  Briefcase, Monitor, FileText, TreePine, Flame,
  Building2, Award, Sparkles, GraduationCap, Crown,
}

// 预设汇报要求文字
const PRESET_PROMPTS = [
  '重点突出销售趋势，方便评估未来与上下游供应商协同',
  '突出TOP5产品表现，分析增长驱动因素',
  '对比各渠道销售效率，识别高ROI渠道',
  '分析客户分层结构，识别核心客户群和流失风险',
  '展示区域差异，识别高增长区域和薄弱环节',
  '聚焦成本结构，提出降本增效建议',
  '强调经营效率指标，包括人效、坪效、周转率',
  '提炼3-5条关键经营洞察，语言简洁、结论明确',
]

function toHex(color, fallback = '#4ECDC4') {
  if (!color) return fallback
  return color.startsWith('#') ? color : `#${color}`
}

function TemplateCard({ tpl, isSelected, onSelect }) {
  const IconComp = ICON_MAP[tpl.icon] || Briefcase
  const bgStart = toHex(tpl?.colors?.bg_start, '#1a1a2e')
  const bgEnd = toHex(tpl?.colors?.bg_end, '#16213e')
  const accent = toHex(tpl?.colors?.accent, '#4ECDC4')
  const textDark = toHex(tpl?.colors?.text_dark, '#1a1a2e')
  const isLight = ['minimal_white', 'fresh_cyan'].includes(tpl.key)
  const assetBase = import.meta.env.BASE_URL || '/'
  const coverCandidates = useMemo(() => {
    const key = tpl.key || ''
    const withBase = (p) => (p?.startsWith('/') ? `${assetBase.replace(/\/$/, '')}${p}` : p)
    const explicit = tpl.cover ? [withBase(tpl.cover)] : []
    const auto = key ? [
      withBase(`/images/${key}.webp`),
      withBase(`/images/${key}.png`),
      withBase(`/images/${key}.jpg`),
      withBase(`/images/${key}.jpeg`),
      withBase(`/images/${key}.svg`),
    ] : []
    return [...new Set([...explicit, ...auto].filter(Boolean))]
  }, [tpl.cover, tpl.key, assetBase])
  const [coverIdx, setCoverIdx] = useState(0)
  const [coverUnavailable, setCoverUnavailable] = useState(false)
  const currentCover = coverCandidates[coverIdx]

  const handleCoverError = () => {
    if (coverIdx < coverCandidates.length - 1) {
      setCoverIdx((i) => i + 1)
      return
    }
    setCoverUnavailable(true)
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className={`pres-tpl-card ${isSelected ? 'selected' : ''}`}
      onClick={() => onSelect(tpl.key)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(tpl.key)
        }
      }}
    >
      {/* 渐变预览区 */}
      <div
        className="pres-tpl-preview"
        style={{
          background: `linear-gradient(135deg, ${bgStart}, ${bgEnd})`,
        }}
      >
        {/* 模拟装饰条 */}
        <div className="pres-tpl-accent-bar" style={{ background: accent }} />
        {!coverUnavailable && currentCover ? (
          <img
            src={currentCover}
            alt={tpl.name}
            className="pres-tpl-preview-image"
            onError={handleCoverError}
            loading="lazy"
          />
        ) : (
          <IconComp
            size={32}
            className="pres-tpl-preview-icon"
            style={{ color: isLight ? textDark : '#fff' }}
          />
        )}
      </div>

      {/* 信息区 */}
      <div className="pres-tpl-info">
        <span className="pres-tpl-name">{tpl.name}</span>
        <span className="pres-tpl-desc">{tpl.description}</span>
      </div>
    </div>
  )
}

export default function TemplateGallery({
  templates,
  selectedKey,
  onSelect,
  customPrompt,
  onCustomPromptChange,
  onGenerate,
  canGenerate,
  generateDisabledHint = '',
  generating,
}) {
  const displayTemplates = templates?.length ? templates : PPTIST_TEMPLATE_OPTIONS

  return (
    <div className="pres-template-gallery">
      <h2 className="pres-section-title">选择汇报模板</h2>

      <div className="pres-tpl-grid">
        {displayTemplates.map((tpl) => (
          <TemplateCard
            key={tpl.key}
            tpl={tpl}
            isSelected={selectedKey === tpl.key}
            onSelect={onSelect}
          />
        ))}
      </div>

      {/* 自定义提示 */}
      <div className="pres-custom-prompt">
        {/* 分割线 */}
        <div className="pres-prompt-divider" />

        {/* 预设汇报要求 + 输入生成区 */}
        <div className="pres-prompt-content-wrapper">
          <div className="pres-prompt-panel">
            <div className="pres-prompt-panel-left">
              <div className="pres-prompt-panel-title">快速要求预设</div>
              <div className="pres-prompt-presets">
                {PRESET_PROMPTS.map((prompt, index) => (
                  <button
                    key={index}
                    className="pres-prompt-preset-item"
                    onClick={() => {
                      // 如果输入框已有内容，追加；否则直接设置
                      const newPrompt = customPrompt
                        ? `${customPrompt}；${prompt}`
                        : prompt
                      onCustomPromptChange(newPrompt)
                    }}
                    title={prompt}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>

            <div className="pres-prompt-panel-right">
              <label className="pres-prompt-label">汇报要求（可选）</label>
              <textarea
                className="pres-prompt-input"
                placeholder="例如：重点分析销售趋势，突出 TOP5 产品..."
                value={customPrompt}
                onChange={(e) => onCustomPromptChange(e.target.value)}
                rows={3}
              />
              <div className="pres-prompt-actions">
                <button
                  className="pres-btn-primary pres-generate-inline-btn"
                  onClick={onGenerate}
                  disabled={!canGenerate || generating}
                  title={!canGenerate && generateDisabledHint ? generateDisabledHint : ''}
                >
                  {generating ? (
                    <>
                      <Loader2 size={16} className="pres-spinner" />
                      <span>生成中...</span>
                    </>
                  ) : (
                    <>
                      <Wand2 size={16} />
                      <span>生成汇报</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
