/**
 * 套餐只读 API（不含支付）
 */
import appConfig from '../config/appConfig'

const getBaseUrl = () => appConfig.apiBaseUrl || ''

export async function getMySubscription(accessToken) {
  const res = await fetch(`${getBaseUrl()}/api/plans/my`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    if (res.status === 401) return null
    throw new Error('获取订阅信息失败')
  }
  return res.json()
}
