// 控制台访问策略：关闭时仅回环客户端；开启后仅同源，管理凭据仍必须验证。
import net from 'node:net';
import crypto from 'node:crypto';

function isLoopbackAddress(address) {
  const a = String(address || '').toLowerCase();
  if (a === '::1') return true;
  if (/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(a)) return true;
  const v4 = a.startsWith('::ffff:') ? a.slice(7) : a;
  return net.isIP(v4) === 4 && v4.split('.')[0] === '127';
}

function isLoopbackHostname(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  return h === 'localhost' || isLoopbackAddress(h);
}

function hostUrl(host, protocol = 'http:') {
  if (typeof host !== 'string' || !host || /\s/.test(host)) return null;
  try {
    const url = new URL(`${protocol}//${host}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url;
  } catch { return null; }
}

function originUrl(origin) {
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) return null;
    return url;
  } catch { return null; }
}

export function consoleOriginAllowed(req, remoteEnabled = false) {
  const headers = req.headers || {};
  const host = hostUrl(headers.host || (remoteEnabled ? '' : '127.0.0.1'));
  if (!host) return false;
  const origin = headers.origin ? originUrl(headers.origin) : null;
  if (headers.origin && !origin) return false;
  if (remoteEnabled !== true) {
    // 不信客户端自报的 Host / X-Forwarded-For；真实非回环连接不能伪装成本机。
    if (!isLoopbackAddress(req.socket?.remoteAddress) || !isLoopbackHostname(host.hostname)) return false;
    if (headers.forwarded) return false;
    for (const name of ['x-forwarded-for', 'x-real-ip']) {
      if (headers[name] && !String(headers[name]).split(',').every(x => isLoopbackAddress(x.trim()))) return false;
    }
    return !origin || isLoopbackHostname(origin.hostname);
  }
  // 反向代理可能终止 HTTPS，故使用浏览器 Origin 的协议规范化 Host 的默认端口。
  // 只允许同源，不把开关变成 ACAO:* 或任意私网网页的管理授权。
  return !origin || origin.host === hostUrl(headers.host, origin.protocol)?.host;
}

function sameSecret(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(value), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function consoleCredentialAuthorized(req, primary) {
  if (typeof primary !== 'string' || !primary) return false;
  const headers = req.headers || {};
  const authorization = typeof headers.authorization === 'string' ? headers.authorization.trim() : '';
  if (/^basic /i.test(authorization)) {
    const encoded = authorization.slice(6).trim();
    if (encoded.length > 4096 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(encoded)) return false;
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) return false;
    const text = decoded.toString('utf8'), colon = text.indexOf(':');
    return colon >= 0 && text.slice(0, colon) === 'admin' && sameSecret(text.slice(colon + 1), primary);
  }
  const bearer = /^bearer /i.test(authorization) ? authorization.slice(7).trim() : authorization;
  return sameSecret(bearer, primary) || sameSecret(headers['x-api-key'], primary);
}
