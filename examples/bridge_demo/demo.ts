// demo.ts — 契约桥端到端示例的 TypeScript 侧(S-4,plan §4.21 / R-16)。
// Ming 侧 = demo.ming(extern fn 声明);契约桩 = demo.mingi(bridge extract 生成,入库黄金)。
// 契约提取是确定性模式:只解析 JSDoc 参数/返回描述里的二元算术不等式,解析不了不发明语义。

/**
 * 把 x 夹取到 [lo, hi] 区间。
 *
 * @param x 待夹取的值(`x >= lo` 且 `x <= hi` 是常规调用面)
 * @param lo 下界(`lo <= hi`)
 * @param hi 上界
 * @returns 夹取结果(`result >= lo`)
 */
export function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/**
 * 求数值数组之和。
 *
 * @param xs 非空数组(`xs.length > 0`;`length` 映射为 Ming 边界符号 `len$xs`)
 * @returns 元素和(`result >= 0`)
 */
export function sum(xs: readonly number[]): number {
  let s = 0;
  for (const v of xs) s += v;
  return s;
}

/**
 * 演示诚实跳过:参数类型 any 不在映射表 → 整函数不进桩,只在桩头具名注记。
 */
export function parseAny(input: any): number {
  return 0;
}
