/**
 * renderer/components/notation —— `SvgNode` → React SVG 元素（M2 方案 v1.1.1
 * §2.2 / §2.3 / §6 T3）。
 *
 * 通用哑组件：无状态、无分支决策，只做一件事——把 `notation/svg/node.ts` 的纯数据
 * 树递归渲染成 React 元素。所有几何/文案/class 名已由各记谱的 `toSvg.ts` 决定好，
 * 这里不重新解释它们。
 *
 * **属性名映射规则**（kebab-case → React 属性名，唯一在这里发生，`SvgNode` 本身
 * 只用原始 SVG 属性名，见 `svg/node.ts` 文件头）：
 * - `class` → `className`（React 的特殊情形，不是通用 kebab→camel 规则能推出的）；
 * - `data-*` / `aria-*` → 原样保留（React 对这两类前缀按字面属性名直传给 DOM，
 *   不做驼峰化——这是 React 自己的约定，不是本文件发明的）；
 * - 其余一律做通用 kebab-case → camelCase 转换（如 `text-anchor` → `textAnchor`、
 *   `stroke-width` → `strokeWidth`）；没有连字符的属性名（`x` / `cx` / `r` / `width`
 *   …）原样返回。
 *
 * 用 `createElement` 而非 JSX：`SvgNode.tag` 是运行期字符串，JSX 标签名必须是编译期
 * 已知的标识符（小写会被当成 DOM 标签字面量、大写会被当成变量引用组件），两者都
 * 表达不出「用一个字符串变量当标签名」，只有 `createElement(tagString, …)` 能做到。
 */

import { createElement, type ReactElement } from 'react';

import { isTextTag, type SvgAttrValue, type SvgNode, type SvgTextNode } from '../../../notation/svg/node';

/** 判别联合的类型收窄：按 `tag` 落在哪一边判定（与 `serializeSvg.ts` 的同名做法一致）。 */
function isSvgTextNode(node: SvgNode): node is SvgTextNode {
  return isTextTag(node.tag);
}

interface SvgTreeProps {
  readonly node: SvgNode;
}

function kebabToReactAttrName(name: string): string {
  if (name === 'class') return 'className';
  if (name.startsWith('data-') || name.startsWith('aria-')) return name;
  return name.replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

function toReactProps(attrs: Readonly<Record<string, SvgAttrValue>>): Record<string, SvgAttrValue> {
  const props: Record<string, SvgAttrValue> = {};
  for (const [key, value] of Object.entries(attrs)) {
    props[kebabToReactAttrName(key)] = value;
  }
  return props;
}

/** `key` 只在渲染兄弟数组（`children`）时才有意义，根节点调用时省略即可。 */
function renderSvgNode(node: SvgNode, key?: number | string): ReactElement {
  const props = key === undefined ? toReactProps(node.attrs) : { key, ...toReactProps(node.attrs) };

  if (isSvgTextNode(node)) {
    return createElement(node.tag, props, node.text);
  }

  return createElement(
    node.tag,
    props,
    node.children.map((child, index) => renderSvgNode(child, index)),
  );
}

export function SvgTree({ node }: SvgTreeProps): ReactElement {
  return renderSvgNode(node);
}
