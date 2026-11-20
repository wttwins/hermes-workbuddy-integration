// 模型名称展示：只修饰 API 响应名称，不修改模型 ID、目录缓存或路由配置。
/** 只有已知的数值零倍率才标 Free；未知、字符串、非零倍率一律不推断免费。 */
export function withFreeLabel(name, multiplier, enabled = true) {
  if (enabled !== true || !Number.isFinite(multiplier) || multiplier !== 0) return name;
  if (typeof name !== 'string' || !name.trim()) return name;
  // 保留上游已经提供的免费标记，避免重复后缀。
  if (/\bfree\b|免费/i.test(name)) return name;
  return `${name} (Free)`;
}
