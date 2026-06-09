// ============================================================================
// PPTist 服务层适配 — 改为加载本地模板 + 调用 SheetBot 后端 API
// ============================================================================
import axios from './axios'
import fetchRequest from './fetch'

// SheetBot 后端地址（同源，使用相对路径）
const BACKEND_URL = ''

interface ImageSearchPayload {
  query: string;
  orientation?: 'landscape' | 'portrait' | 'square' | 'all';
  locale?: 'zh' | 'en';
  order?: 'popular' | 'latest';
  size?: 'large' | 'medium' | 'small';
  image_type?: 'all' | 'photo' | 'illustration' | 'vector';
  page?: number;
  per_page?: number;
}

interface AIPPTOutlinePayload {
  content: string
  language: string
  model: string
}

interface AIPPTPayload {
  content: string
  language: string
  style: string
  model: string
}

interface AIWritingPayload {
  content: string
  command: string
}

export default {
  // 从 public/mocks/pptist/ 目录加载模板数据
  getMockData(filename: string): Promise<any> {
    return axios.get(`./mocks/pptist/${filename}.json`)
  },

  // 图片搜索：对接 SheetBot 后端的 Pexels 代理
  searchImage(body: ImageSearchPayload): Promise<any> {
    return axios.post(`${BACKEND_URL}/api/pptx/image-search`, body)
  },

  // AIPPT 大纲生成：对接 SheetBot 后端
  AIPPT_Outline({
    content,
    language,
    model,
  }: AIPPTOutlinePayload): Promise<any> {
    return fetchRequest(`${BACKEND_URL}/api/pptx/aippt-outline`, {
      method: 'POST',
      body: JSON.stringify({
        content,
        language,
        model,
        stream: true,
      }),
    })
  },

  // AIPPT 幻灯片生成：对接 SheetBot 后端
  AIPPT({
    content,
    language,
    style,
    model,
  }: AIPPTPayload): Promise<any> {
    return fetchRequest(`${BACKEND_URL}/api/pptx/aippt-generate`, {
      method: 'POST',
      body: JSON.stringify({
        content,
        language,
        model,
        style,
        stream: true,
      }),
    })
  },

  // AI 写作辅助：对接 SheetBot 后端
  AI_Writing({
    content,
    command,
  }: AIWritingPayload): Promise<any> {
    return fetchRequest(`${BACKEND_URL}/api/pptx/ai-writing`, {
      method: 'POST',
      body: JSON.stringify({
        content,
        command,
        stream: true,
      }),
    })
  },
}
