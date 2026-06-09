/**
 * 文件/文件夹管理 API 客户端
 */
import appConfig from '../config/appConfig'

const getBaseUrl = () => appConfig.apiBaseUrl || ''

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
  }
}

async function buildHttpError(res, fallbackMessage) {
  const data = await res.json().catch(() => ({}))
  const detail = data?.detail
  const isQuota = typeof detail === 'object' && (detail.code === 'quota_exceeded' || detail.code === 'feature_disabled')
  const message = isQuota ? detail.message
    : (typeof detail === 'string' ? detail : (detail?.message || fallbackMessage))
  const err = new Error(message)
  err.detail = detail
  err.status = res.status
  err.isQuota = isQuota
  return err
}

// ==================== Files ====================

export async function getFileTree(token) {
  const res = await fetch(`${getBaseUrl()}/api/files/tree`, {
    headers: authHeaders(token),
  })
  if (!res.ok) throw await buildHttpError(res, '获取文件树失败')
  return res.json()
}

export async function listFiles(token, { folderId, starred } = {}) {
  const params = new URLSearchParams()
  if (folderId !== undefined && folderId !== null) params.set('folder_id', folderId)
  if (starred !== undefined && starred !== null) params.set('starred', starred)
  const qs = params.toString()
  const res = await fetch(`${getBaseUrl()}/api/files${qs ? `?${qs}` : ''}`, {
    headers: authHeaders(token),
  })
  if (!res.ok) throw await buildHttpError(res, '获取文件列表失败')
  return res.json()
}

export async function searchFiles(token, query) {
  const res = await fetch(`${getBaseUrl()}/api/files/search?q=${encodeURIComponent(query)}`, {
    headers: authHeaders(token),
  })
  if (!res.ok) throw await buildHttpError(res, '搜索失败')
  return res.json()
}

export async function uploadFile(token, file, folderId = null, filenameOverride = null) {
  const formData = new FormData()
  const filename = filenameOverride || file?.name || 'workbook.xlsx'
  formData.append('file', file, filename)
  const params = folderId ? `?folder_id=${folderId}` : ''
  const res = await fetch(`${getBaseUrl()}/api/files/upload${params}`, {
    method: 'POST',
    headers: authHeaders(token),
    body: formData,
  })
  if (!res.ok) throw await buildHttpError(res, '上传失败')
  return res.json()
}

export function uploadFileWithProgress(token, file, { folderId = null, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const formData = new FormData()
    formData.append('file', file)
    const params = folderId ? `?folder_id=${encodeURIComponent(folderId)}` : ''
    const xhr = new XMLHttpRequest()

    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return
      const percent = Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100)))
      onProgress?.({
        percent,
        loaded: event.loaded,
        total: event.total
      })
    })

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText || '{}'))
        } catch {
          reject(new Error('解析上传响应失败'))
        }
        return
      }
      try {
        const data = JSON.parse(xhr.responseText || '{}')
        const detail = data?.detail
        const isQuota = typeof detail === 'object' && (detail.code === 'quota_exceeded' || detail.code === 'feature_disabled')
        let msg
        if (isQuota) {
          msg = detail.message
        } else if (typeof detail === 'string' && detail) {
          msg = detail
        } else if (typeof detail === 'object' && detail?.message) {
          msg = detail.message
        } else {
          msg = `上传失败 (HTTP ${xhr.status})`
        }
        const err = new Error(msg)
        err.isQuota = isQuota
        err.status = xhr.status
        reject(err)
      } catch {
        reject(new Error(`上传失败 (HTTP ${xhr.status})`)
        )
      }
    })

    xhr.addEventListener('error', () => reject(new Error('网络错误，上传失败')))
    xhr.addEventListener('timeout', () => reject(new Error('上传超时')))
    xhr.open('POST', `${getBaseUrl()}/api/files/upload${params}`)
    xhr.timeout = 10 * 60 * 1000
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.send(formData)
  })
}

export async function toggleStar(token, fileId) {
  const res = await fetch(`${getBaseUrl()}/api/files/${fileId}/star`, {
    method: 'PATCH',
    headers: authHeaders(token),
  })
  if (!res.ok) throw await buildHttpError(res, '操作失败')
  return res.json()
}

export async function renameFile(token, fileId, name) {
  const res = await fetch(`${getBaseUrl()}/api/files/${fileId}/rename`, {
    method: 'PATCH',
    headers: {
      ...authHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw await buildHttpError(res, '重命名失败')
  return res.json()
}

export async function moveFile(token, fileId, folderId) {
  const res = await fetch(`${getBaseUrl()}/api/files/${fileId}/move`, {
    method: 'PATCH',
    headers: {
      ...authHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ folder_id: folderId }),
  })
  if (!res.ok) throw await buildHttpError(res, '移动失败')
  return res.json()
}

export async function deleteFile(token, fileId) {
  const res = await fetch(`${getBaseUrl()}/api/files/${fileId}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  })
  if (!res.ok) throw await buildHttpError(res, '删除失败')
  return res.json()
}

export async function downloadFile(token, fileId) {
  const ts = Date.now()
  const res = await fetch(`${getBaseUrl()}/api/files/${fileId}/download?_=${ts}`, {
    headers: authHeaders(token),
    cache: 'no-store',
  })
  if (!res.ok) throw await buildHttpError(res, '下载文件失败')
  return res.blob()
}

export async function saveFileContent(token, fileId, fileBlob, filename = 'workbook.xlsx', options = {}) {
  const { expectedUpdatedAt = null, expectedContentVersion = null } = options
  const formData = new FormData()
  formData.append('file', fileBlob, filename)
  const headers = authHeaders(token)
  if (expectedContentVersion) {
    headers['X-Expected-Content-Version'] = expectedContentVersion
  }
  if (expectedUpdatedAt) {
    headers['X-Expected-Updated-At'] = expectedUpdatedAt
  }
  const res = await fetch(`${getBaseUrl()}/api/files/${fileId}/content`, {
    method: 'PUT',
    headers,
    body: formData,
  })
  if (!res.ok) throw await buildHttpError(res, '保存文件失败')
  return res.json()
}

// ==================== Storage Usage ====================

export async function getStorageUsage(token) {
  const res = await fetch(`${getBaseUrl()}/api/files/storage-usage`, {
    headers: authHeaders(token),
  })
  if (!res.ok) throw await buildHttpError(res, '获取存储用量失败')
  return res.json()
}

// ==================== Folders ====================

export async function listFolders(token, parentId = null) {
  const params = parentId ? `?parent_id=${parentId}` : ''
  const res = await fetch(`${getBaseUrl()}/api/folders${params}`, {
    headers: authHeaders(token),
  })
  if (!res.ok) throw await buildHttpError(res, '获取文件夹失败')
  return res.json()
}

export async function createFolder(token, name, parentId = null) {
  const res = await fetch(`${getBaseUrl()}/api/folders`, {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, parent_id: parentId }),
  })
  if (!res.ok) throw await buildHttpError(res, '创建文件夹失败')
  return res.json()
}

export async function renameFolder(token, folderId, name) {
  const res = await fetch(`${getBaseUrl()}/api/folders/${folderId}`, {
    method: 'PATCH',
    headers: {
      ...authHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw await buildHttpError(res, '重命名失败')
  return res.json()
}

export async function moveFolder(token, folderId, parentId) {
  const res = await fetch(`${getBaseUrl()}/api/folders/${folderId}/move`, {
    method: 'PATCH',
    headers: {
      ...authHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ parent_id: parentId }),
  })
  if (!res.ok) throw await buildHttpError(res, '移动文件夹失败')
  return res.json()
}

export async function deleteFolder(token, folderId) {
  const res = await fetch(`${getBaseUrl()}/api/folders/${folderId}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  })
  if (!res.ok) throw await buildHttpError(res, '删除文件夹失败')
  return res.json()
}
