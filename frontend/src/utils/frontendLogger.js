// frontend/src/utils/frontendLogger.js
/**
 * 带用户上下文的前端日志工具
 *
 * 在关键操作的 console 输出中自动附带用户标识，
 * 便于远程 DevTools 排查用户反馈的问题。
 *
 * 用法:
 *   import { flog, setLogUser } from './utils/frontendLogger'
 *   setLogUser('zhangsan')      // 登录后调用一次
 *   flog.info('App', '操作完成', { id: 42 })
 *   // => [App] @zhangsan 操作完成 { id: 42 }
 */

const _ctx = { user: '' }

export function setLogUser(username) {
  _ctx.user = username || ''
}

function _prefix(tag) {
  return _ctx.user ? `[${tag}] @${_ctx.user}` : `[${tag}]`
}

export const flog = {
  log(tag, ...args)   { console.log(_prefix(tag), ...args) },
  info(tag, ...args)  { console.log(_prefix(tag), ...args) },
  warn(tag, ...args)  { console.warn(_prefix(tag), ...args) },
  error(tag, ...args) { console.error(_prefix(tag), ...args) },
  debug(tag, ...args) { console.debug(_prefix(tag), ...args) },
}

export default flog
