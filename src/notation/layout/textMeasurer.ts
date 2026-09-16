/**
 * notation/layout —— 可注入的确定性文本度量（M2 方案 v1.1.1 §2.8）。
 *
 * 简谱歌词、和弦名、TAB 和弦行、装饰记号占位都会让文本宽度参与布局。直接调 DOM 的
 * `measureText` / `getBBox` 会把布局绑死在宿主字体上：node 环境测不了，不同机器结果
 * 不同，三平台 CI 必然漂移。因此文本宽度**只能**通过 `TextMeasurer` 得到：
 *
 * - **生产实现**：renderer 侧未来可选择性注入一个基于 DOM 的实现（M2 不做，若不做则
 *   生产与测试共用下面的确定性实现）。
 * - **默认实现**：`createDeterministicTextMeasurer` 按 `metrics.ts` 里的每字符宽度表
 *   （区分 ASCII / CJK / 其它）纯查表计算，零 DOM 依赖，同输入同输出。**测试一律用它**。
 * - 所有 layout 函数把 `TextMeasurer` 作为**显式参数**传入，不做模块级单例、不用全局
 *   默认值兜底——否则「忘了注入」会静默退化成某个隐藏实现（§2.8）。
 */

import { TEXT_METRICS } from './metrics';

/** 度量所需的最小文本样式：目前只有字号会改变宽度/高度的缩放比例。 */
export interface TextStyle {
  readonly fontSize: number;
}

/** 一次度量的结果，单位与布局其余部分一致：abstract unit（D6）。 */
export interface TextMeasurement {
  readonly width: number;
  readonly height: number;
}

/**
 * 可注入的文本度量契约。`measure` 必须是纯函数：同一 `(text, style)` 必须得到同一结果，
 * 不得读取任何外部可变状态（当前时间、DOM、随机数）。
 */
export interface TextMeasurer {
  measure(text: string, style: TextStyle): TextMeasurement;
}

/**
 * `createDeterministicTextMeasurer` 所需的度量表形状，与 `metrics.ts` 的 `TEXT_METRICS`
 * 同构；调用方可以传入自定义表（例如测试里验证「表变了、结果跟着变」），默认取
 * `TEXT_METRICS`。
 */
export interface TextMetricsTable {
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly asciiCharWidth: number;
  readonly cjkCharWidth: number;
  readonly fallbackCharWidth: number;
}

type CharCategory = 'ascii' | 'cjk' | 'fallback';

function inAnyRange(codePoint: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([start, end]) => codePoint >= start && codePoint <= end);
}

/**
 * CJK / 全角字符的 Unicode 码点区间（闭区间）：中日韩表意文字、假名、谚文音节、
 * 全角标点与全角形式，以及 CJK 扩展 B（补充平面，代理对字符，P2-3）。这是一份
 * 「够用」而非「穷尽」的近似分类表——本文件只需要区分「明显更宽的表意/全角字符」
 * 与「其它」，不追求覆盖全部 Unicode 脚本。
 *
 * **不含半角片假名 / 半角符号**（`FF61–FF9F` / `FFE8–FFEE`）：它们虽落在
 * `FF00–FFEF` 这个常被笼统称为「全角/半角形式」的块里，但视觉宽度接近 ASCII，
 * 单独分类见 `ASCII_WIDTH_EXTRA_RANGES`（P2-4）。
 */
const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x11ff], // Hangul Jamo
  [0x2e80, 0x2eff], // CJK Radicals Supplement
  [0x2f00, 0x2fdf], // Kangxi Radicals
  [0x3000, 0x303f], // CJK 标点符号
  [0x3040, 0x30ff], // 平假名 / 片假名
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 统一表意文字
  [0xac00, 0xd7a3], // 谚文音节
  [0xf900, 0xfaff], // CJK 兼容表意文字
  [0xff00, 0xff60], // 全角形式（字母数字与标点）
  [0xffe0, 0xffe6], // 全角符号
  [0x20000, 0x2a6df], // CJK 扩展 B（补充表意文字平面，代理对字符）
];

/**
 * `FF00–FFEF` 块里视觉宽度接近 ASCII 的半角片段：半角片假名与半角符号（P2-4）。
 * 与 `CJK_RANGES` 互斥（分别覆盖同一父块的不同子区间），不依赖分类顺序。
 */
const ASCII_WIDTH_EXTRA_RANGES: readonly (readonly [number, number])[] = [
  [0xff61, 0xff9f], // 半角片假名
  [0xffe8, 0xffee], // 半角符号
];

function classifyCodePoint(codePoint: number): CharCategory {
  if (codePoint <= 0x7f) return 'ascii';
  if (inAnyRange(codePoint, ASCII_WIDTH_EXTRA_RANGES)) return 'ascii';
  if (inAnyRange(codePoint, CJK_RANGES)) return 'cjk';
  return 'fallback';
}

function charWidth(codePoint: number, table: TextMetricsTable): number {
  const category = classifyCodePoint(codePoint);
  switch (category) {
    case 'ascii':
      return table.asciiCharWidth;
    case 'cjk':
      return table.cjkCharWidth;
    case 'fallback':
      return table.fallbackCharWidth;
    default: {
      const exhaustive: never = category;
      return exhaustive;
    }
  }
}

/**
 * 默认的确定性 `TextMeasurer`：纯查表，无 DOM/canvas 依赖，任何环境（node/浏览器/
 * Electron 主进程）结果都一致。
 *
 * 宽度按 `style.fontSize` 相对 `table.fontSize` 的比例缩放每字符宽度；高度按同一比例
 * 缩放 `table.lineHeight`。空字符串的宽度为 0，高度仍取一行的行高——一个空文本节点
 * 依然占据一行的纵向空间。
 */
export function createDeterministicTextMeasurer(table: TextMetricsTable = TEXT_METRICS): TextMeasurer {
  return {
    measure(text: string, style: TextStyle): TextMeasurement {
      const scale = style.fontSize / table.fontSize;
      let width = 0;
      for (const char of text) {
        const codePoint = char.codePointAt(0);
        if (codePoint === undefined) continue;
        width += charWidth(codePoint, table) * scale;
      }
      return { width, height: table.lineHeight * scale };
    },
  };
}
