/**
 * notation/svg —— `SvgNode` 纯数据树（M2 方案 v1.1.1 §2.3 / §2.7 / §4.2）。
 *
 * 为什么先落成数据树而不是直接产出 JSX/DOM（§2.3）：
 * - **可测性**：`SvgNode` 是纯数据、`serializeSvg` 是纯函数 → 渲染测试可以在 vitest
 *   默认 node 环境跑，不需要 jsdom / Testing Library / 真实浏览器。
 * - **复用**：同一棵树既能交给 React 的哑组件 `SvgTree` 渲染，也能直接序列化成
 *   `.svg` 字符串，供 M5 打印/导出复用，不必重写一遍几何。
 * - **边界**：`src/notation/**` 因此可以整体禁止 import `react` / DOM API，是一条
 *   无例外的硬规则，不是「尽量」。
 *
 * 属性命名走**原始 SVG 属性名**（kebab-case，如 `text-anchor` / `stroke-width` /
 * `data-event-id`），不是 JSX 的 camelCase——`SvgNode` 直接对应最终序列化字符串，
 * camelCase↔kebab-case 的转换是 React 组件（`SvgTree`）的事，不在这里发生。
 *
 * `data-*` 属性用于携带 `Anchor` 相关标识（`data-voice-id` / `data-event-id` /
 * `data-relation-id`），供 M3 的谱面↔诊断联动使用（§4.2）；本文件只提供**任意字符串
 * 键**的属性通道，不为此额外引入 Domain 类型以外的依赖。
 */

/** 属性值只允许 string / number——不接受 boolean / null / undefined 之类隐式转换。 */
export type SvgAttrValue = string | number;

/** 属性表：键是原始 SVG 属性名（含 `data-*`），值只能是 string / number。 */
export type SvgAttrs = Readonly<Record<string, SvgAttrValue>>;

/**
 * 携带文本内容的 tag：`text` / `tspan` / `title`。
 *
 * **`text`/`tspan` 节点不允许再嵌套子节点**（含 `tspan` 嵌套 `tspan` 的富文本混排）：
 * M2 不需要这个能力，需要时再扩展，不预先设计（§2.7 同源精神——不为「可能用得上」
 * 预留字段）。这条限制现在由类型本身保证，见下面 `SvgTextNode`。
 */
export const TEXT_TAGS = ['text', 'tspan', 'title'] as const;
export type SvgTextTag = (typeof TEXT_TAGS)[number];

/**
 * 容器 / 自闭合几何 tag（§2.7 primitives 准入同源精神：只收四种记谱都可能用到的、
 * 语义单一的 SVG 结构元素）。**没有** `foreignObject` / `image` / `use` 等会引入
 * 外部内容或 DOM 特性的标签——M2 不需要它们，加了也逃不过「谁在用」的追问。
 */
export const CONTAINER_TAGS = [
  'svg',
  'g',
  'rect',
  'line',
  'circle',
  'ellipse',
  'path',
  'polyline',
  'polygon',
] as const;
export type SvgContainerTag = (typeof CONTAINER_TAGS)[number];

/** 全部合法 tag 的并集，仅用于 `isSvgTag` 这类「随便给我一个字符串，是不是合法 tag」的判定。 */
export const SVG_TAGS = [...CONTAINER_TAGS, ...TEXT_TAGS] as const;
export type SvgTag = SvgContainerTag | SvgTextTag;

export function isContainerTag(tag: string): tag is SvgContainerTag {
  return CONTAINER_TAGS.some((candidate) => candidate === tag);
}

export function isTextTag(tag: string): tag is SvgTextTag {
  return TEXT_TAGS.some((candidate) => candidate === tag);
}

/** 运行时白名单校验（覆盖两类 tag），供构造 helper 内部使用，也单独导出供测试直接验证。 */
export function isSvgTag(tag: string): tag is SvgTag {
  return isContainerTag(tag) || isTextTag(tag);
}

/**
 * 文本节点：`text` / `tspan` / `title`。只携带 `text`，**类型上就不允许**再给
 * `children`（`children?: never` 配合 `exactOptionalPropertyTypes` 意味着这个字段
 * 根本不能被赋值，只能省略）。
 */
export interface SvgTextNode {
  readonly tag: SvgTextTag;
  readonly attrs: SvgAttrs;
  readonly text: string;
  readonly children?: never;
}

/**
 * 容器 / 自闭合几何节点：只携带 `children`（为空数组即自闭合，如 `rect` / `line` /
 * `circle`），**类型上就不允许**再给 `text`。
 */
export interface SvgContainerNode {
  readonly tag: SvgContainerTag;
  readonly attrs: SvgAttrs;
  readonly children: readonly SvgNode[];
  readonly text?: never;
}

/**
 * 一个 SVG 节点：纯数据，无方法、无隐藏状态。**判别联合**（按 `tag` 落在
 * `SvgTextTag` / `SvgContainerTag` 哪一边判别）——「同时给 `text` 和 `children`」
 * 在编译期就不可表达，不是运行时约定或测试钉住的行为。
 */
export type SvgNode = SvgTextNode | SvgContainerNode;

/** 构造一个容器/自闭合元素节点：无文本内容，可以携带子节点（为空即自闭合）。 */
export function element(
  tag: SvgContainerTag,
  attrs: SvgAttrs = {},
  children: readonly SvgNode[] = [],
): SvgContainerNode {
  if (!isContainerTag(tag)) {
    throw new RangeError(`element: unknown svg container tag "${tag}"`);
  }
  return { tag, attrs, children };
}

/**
 * 构造一个携带文本内容的节点（`text` / `tspan` / `title`）。不接受 `children`——
 * 见 `SvgTextTag` 处的说明，这是类型层面的限制，不只是文档约定。
 */
export function textElement(tag: SvgTextTag, text: string, attrs: SvgAttrs = {}): SvgTextNode {
  if (!isTextTag(tag)) {
    throw new RangeError(`textElement: unknown svg text tag "${tag}"`);
  }
  return { tag, attrs, text };
}
