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

/**
 * 读取配置文件文本(演示桥接元数据的**效果面**与**污点面**,R-18)。
 *
 * TS 类型系统无法表达副作用;`@effects` 声明的是 Ming 侧 `with fs` 门禁需要、
 * TypeScript 无法检查的那部分——桩携带它,下游工具/Agent 才能核对。
 * 文件内容来自外部 → `@taint return` 标污,桩类型为 `Untrusted[str]`。
 *
 * @param path 配置文件路径(相对路径)
 * @effects fs
 * @taint return
 * @returns 文件内容(外部输入)
 */
export function readConfig(path: string): string {
  // 示例省略实现:真实实现由宿主提供(如 node:fs.readFileSync(path, "utf8"))。
  return "";
}

/**
 * 在外部文本中查找键(演示**参数级污点**:`@taint param raw`)。
 *
 * @param raw 外部文本(不可信 → 桩类型 `Untrusted[str]`)
 * @param key 键名(干净参数)
 * @taint param raw
 * @returns 是否命中
 */
export function hasKey(raw: string, key: string): boolean {
  return raw.indexOf(key) >= 0;
}
