/**
 * canonical 序列化 —— 组装（M1.7 T3 骨架，方案 v1.1 §3 / spec §27.3）。
 *
 * 输出 = header → `%%` 指令 / text block → 每声部 `V:` 声明 → body。
 * **body 由 T4/T5 落地**，本任务留空数组占位：T3 只保证骨架（行序、编码、
 * 末尾换行）与 header/指令/`V:` 三块内容正确。
 *
 * 固定输出形态（spec §27.3，Muse Next 决定）：一律 UTF-8、无 BOM、LF 行尾、
 * 末尾恒有换行。因此 `encodeJcx` 恒以 `'utf-8'` 调用，也不需要
 * `onUnencodable`——UTF-8 能编码任何合法 Unicode 标量值。
 */

import type { Score } from '../../../../domain';
import { encodeJcx } from '../encodeJcx';
import type { CanonicalOptions, SerializeResult } from '../types';
import { renderDirectives } from './directives';
import { renderHeader } from './header';
import { renderVoiceDeclaration } from './voice';
import type { CanonicalDiagnostic } from './voice';

export type { CanonicalDiagnostic } from './voice';
export { canonicalVoiceLabel, renderVoiceDeclaration } from './voice';
export { renderDirectives } from './directives';
export { renderHeader } from './header';

export function serializeCanonical(score: Score, options: CanonicalOptions): SerializeResult {
  const lines: string[] = [...renderHeader(score, options), ...renderDirectives(score)];
  const diagnostics: CanonicalDiagnostic[] = [];

  for (const voice of score.voices) {
    const declaration = renderVoiceDeclaration(voice);
    lines.push(declaration.line);
    diagnostics.push(...declaration.diagnostics);
  }

  // body（事件 / relation / 歌词 / body 区 `L:`）：T4、T5。
  const body: readonly string[] = [];
  lines.push(...body);

  // 全空（例如一个既无 header 字段、又关掉 magic header 的空 Score）时输出空文本，
  // 而不是一行孤零零的换行。
  const text = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  const encoded = encodeJcx(text, 'utf-8');

  return {
    text,
    bytes: encoded.bytes,
    encoding: 'utf-8',
    diagnostics: [...diagnostics, ...encoded.diagnostics],
  };
}
