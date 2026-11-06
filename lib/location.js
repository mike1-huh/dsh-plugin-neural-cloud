/**
 * 云图 · 网络定位（2026-10-28）
 *
 * IP 城市定位只能到运营商出口（经常偏到隔壁市），所以这里叠一层「网络指纹」：
 *   - netsh 读 Wi-Fi 的 SSID / BSSID（同一 BSSID = 同一地点，比城市准）
 *   - 默认网关（192.168.x.1 这类）
 *   - 城市（ip-api，作参考）
 * 换地点判定优先看 BSSID → SSID → 城市，避免同城 IP 变动误报。
 */
import { execFileSync } from 'node:child_process'

const ENDPOINT = 'http://ip-api.com/json/?lang=zh-CN&fields=status,country,regionName,city,isp,lat,lon,query'

export async function detectLocation(opts = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 8000)
  try {
    const res = await fetch(ENDPOINT, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (!data || data.status !== 'success') return null
    return {
      ip: data.query || '',
      country: data.country || '',
      region: data.regionName || '',
      city: data.city || '',
      isp: data.isp || '',
      lat: data.lat,
      lon: data.lon,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 网络指纹：SSID / BSSID / 网关（读不到就返回 null，不影响 IP 定位）。 */
export function detectNetwork() {
  const out = {}
  try {
    const s = execFileSync('netsh', ['wlan', 'show', 'interfaces'], { encoding: 'utf8', timeout: 4000 })
    const ssid = /^\s*SSID\s*:\s*(.+)$/m.exec(s)
    if (ssid) out.ssid = ssid[1].trim()
    const bssid = /^\s*AP BSSID\s*:\s*(.+)$/m.exec(s)
    if (bssid) out.bssid = bssid[1].trim()
  } catch {}
  try {
    const r = execFileSync('powershell', [
      '-NoProfile', '-Command',
      '(Get-NetRoute -DestinationPrefix 0.0.0.0/0 | Select-Object -First 1).NextHop',
    ], { encoding: 'utf8', timeout: 8000 })
    const gw = r.trim()
    if (gw) out.gateway = gw
  } catch {}
  return Object.keys(out).length ? out : null
}

/**
 * 一行展示：太原理工（CMCC-kfxc-5G）· 中国移动 · 183.x.x.x
 * names 是 SSID → 地名映射（用户可配，如 {"CMCC-kfxc-5G":"太原理工"}）。
 */
export function formatLocation(loc, names = {}) {
  if (!loc) return '（还没检测到位置）'
  const label = (loc.ssid && names[loc.ssid]) || loc.label || ''
  const city = [loc.country, loc.region, loc.city].filter(Boolean).join('')
  const where = label || city || loc.ip || '未知'
  const parts = [where]
  if (loc.ssid && label) parts.push(loc.ssid)
  if (loc.isp) parts.push(loc.isp)
  return parts.join(' · ')
}

/** 换地点判定：BSSID > SSID > 城市。 */
export function locationChanged(prev, next) {
  if (!prev || !next) return false
  if (prev.bssid && next.bssid && prev.bssid !== next.bssid) return true
  if (prev.ssid && next.ssid && prev.ssid !== next.ssid) return true
  const key = l => `${l.region || ''}|${l.city || ''}`
  return key(prev) !== key(next)
}
