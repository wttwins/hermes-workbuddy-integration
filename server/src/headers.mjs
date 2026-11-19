// 上游请求头构造（站点感知）：对齐 CodeBuddy 官方 CLI 的调用形态。
// 站点配置决定 origin / UA / 域名；会话字段按国际站所需的兼容形态发送。
import crypto from 'node:crypto';

/** 通用头（所有上游接口共用） */
export function commonHeaders(site) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: site.origin,
    Referer: site.origin + '/',
    'User-Agent': site.userAgent,
  };
}

/** 聊天接口头：额外携带账号身份头（X-User-Id / X-Enterprise-Id / X-Domain）。 */
export function chatHeaders(site, auth) {
  const h = commonHeaders(site);
  h.Accept = 'text/event-stream';
  h.Authorization = 'Bearer ' + auth.accessToken;
  h['X-Request-ID'] = crypto.randomUUID().replace(/-/g, '');
  // Each stateless API call gets isolated metadata, not a shared global ID.
  h['X-Conversation-Id'] = crypto.randomUUID();
  h['X-Conversation-Request-Id'] = crypto.randomUUID().replace(/-/g, '');
  h['X-Conversation-Message-Id'] = h['X-Request-ID'];
  h['X-Request-Trace-Id'] = crypto.randomUUID();
  h['X-Product'] = site.product || 'SaaS';
  if (auth.uid) h['X-User-Id'] = auth.uid;
  else h['X-No-User-Id'] = '1';
  if (auth.enterpriseId) h['X-Enterprise-Id'] = auth.enterpriseId;
  else h['X-No-Enterprise-Id'] = '1';
  if (auth.domain) h['X-Domain'] = auth.domain;
  else h['X-No-Department-Info'] = '1';
  return h;
}

/** token 刷新头：X-Refresh-Token 只允许出现在刷新接口。 */
export function refreshHeaders(site, auth) {
  const h = commonHeaders(site);
  h['X-Refresh-Token'] = auth.refreshToken;
  h['X-Auth-Refresh-Source'] = 'workbuddy';
  if (auth.enterpriseId) h['X-Enterprise-Id'] = auth.enterpriseId;
  return h;
}

/** 计费/额度接口头。 */
export function billingHeaders(site, auth) {
  const h = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + auth.accessToken,
    Origin: site.origin,
    Referer: site.origin + '/',
    'User-Agent': site.userAgent,
  };
  if (auth.uid) h['X-User-Id'] = auth.uid;
  if (auth.enterpriseId) {
    h['X-Enterprise-Id'] = auth.enterpriseId;
    h['X-Tenant-Id'] = auth.enterpriseId;
  }
  if (auth.domain) h['X-Domain'] = auth.domain;
  return h;
}
