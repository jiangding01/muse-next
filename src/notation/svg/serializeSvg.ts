/**
 * notation/svg —— `SvgNode` → SVG 字符串（M2 方案 v1.1.1 §2.3 / §2.5）。
 *
 * `serializeSvg` 是纯函数，规则全部写死在本文件，不留隐式行为：
 *
 * 1. **属性顺序**：按属性名的 **ASCII 码点升序**排列（不是插入顺序）。选它而不是
 *    插入顺序的原因：两棵「语义相同但字面量里属性写法顺序不同」的 `SvgNode`
 *    （例如一处先写 `x` 后写 `y`，另一处反过来）序列化后必须逐字符相等，这比
 *    「同一个对象两次序列化相等」（插入顺序天然满足）是更强的保证，对 T3 的
 *    「迁移前后 SVG 等价」基线快照更友好。
 * 2. **数字格式化**：四舍五入到小数点后 4 位，再去掉多余的尾随零与可能出现的尾随
 *    小数点；`-0` 归一化为 `0`。不是有限数（`NaN` / `Infinity`）直接抛错——坐标
 *    永远有限是 M2 的不变量（§7-10），序列化层不该悄悄把它吞掉。
 * 3. **转义**：属性值转义 `&` `<` `>` `"` 四个字符（`&` 必须最先转义，否则会把
 *    后续转义产物里的 `&` 二次转义）；文本内容只转义 `&` 与 `<`（SVG/XML 文本节点
 *    里 `>` 与 `"` 不需要转义，多转义不算错但不是本文件选择的规则）。
 * 4. **幂等 / 不修改输入**：本文件不对 `node` 做任何写操作，只读取字段、构造新字符串；
 *    `Object.entries` / `Array.prototype.sort` 都不改变原对象（`sort` 作用于新数组）。
 * 5. **输出格式**：单行，无换行、无缩进——不依赖任何空白格式；空节点（无 `text`
 *    也无 `children`）序列化为自闭合标签 `<tag .../>`。
 *
 * `text` 与 `children` 不再是「按约定互斥」——`SvgNode`（见 `node.ts`）现在是判别
 * 联合，两者共存在编译期就不可表达，因此这里不需要（也不应该再有）「谁优先」的分支。
 */

import { isTextTag, type SvgAttrValue, type SvgNode, type SvgTextNode } from './node';

/** 判别联合的类型收窄：按 `tag` 落在哪一边判定，而不是探测 `text`/`children` 字段是否存在。 */
function isSvgTextNode(node: SvgNode): node is SvgTextNode {
  return isTextTag(node.tag);
}

function escapeAttrValue(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/**
 * 数字属性的确定性格式化：见文件头规则 2。小数位数（4 位）是序列化格式细节，不是
 * 布局尺寸常量，因此就地写字面量，不进 `metrics.ts`（那里只收几何/字体尺寸，
 * 见该文件文件头）。
 *
 * `|value| >= 1e21` 与非有限数同样拒绝：`Number.prototype.toFixed` 在这个量级不会
 * 抛错，而是静默退化成 `ToString`（可能产出科学计数法，如 `"1e+21"`），这会破坏
 * 「输出格式固定、不出现科学计数法」的承诺，所以这里显式挡住，而不是依赖 `toFixed`
 * 自己的边界行为。
 */
function formatNumber(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) >= 1e21) {
    throw new RangeError(`serializeSvg: non-finite or out-of-range numeric attribute value: ${String(value)}`);
  }
  const rounded = Number(value.toFixed(4));
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  return String(normalized);
}

function formatAttrValue(value: SvgAttrValue): string {
  return typeof value === 'number' ? formatNumber(value) : escapeAttrValue(value);
}

function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function serializeAttrs(attrs: SvgNode['attrs']): string {
  const entries = Object.entries(attrs).sort(([a], [b]) => compareKeys(a, b));
  return entries.map(([key, value]) => ` ${key}="${formatAttrValue(value)}"`).join('');
}

/**
 * `SvgNode` → SVG 字符串。同一（深比较相等的）输入无论调用多少次、传入多少个不同
 * 的属性字面量书写顺序，输出逐字符相等；不修改传入的 `node`。
 */
export function serializeSvg(node: SvgNode): string {
  const attrs = serializeAttrs(node.attrs);

  if (isSvgTextNode(node)) {
    return `<${node.tag}${attrs}>${escapeText(node.text)}</${node.tag}>`;
  }

  if (node.children.length === 0) {
    return `<${node.tag}${attrs}/>`;
  }

  const inner = node.children.map((child) => serializeSvg(child)).join('');
  return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}
