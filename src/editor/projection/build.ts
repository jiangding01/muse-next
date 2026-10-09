/**
 * 由 exact source 构建 SourceProjection（`docs/M3_EDITOR_CORE_PLAN.md` §6.1–§6.4）。
 *
 * - 打开 / 新建时用 `createInitialProjection` 确定并冻结 `ProjectionFrame`（受保护前缀、dominant EOL）；
 *   之后每个版本用 `buildProjection(source, frame)` 沿用同一个 frame。
 * - 孤立 CR 只登记位置，不依赖字符本身：用户输入的 U+240D 是普通字符，永远不会被当成 CR。
 */

import { BYTE_ORDER_MARK } from '../text/sourceInvariants';
import { CR_PLACEHOLDER } from './types';
import type { LineEnding, ProjectionFrame, SourceProjection } from './types';

/**
 * 按 CRLF 与 LF 的出现次数确定 dominant EOL：CRLF 多于 LF 时为 `crlf`，否则（含并列、没有换行）为 `lf`。
 * 孤立 CR 不参与统计（§6.2、§6.4）。
 */
export function detectDominantEol(source: string): LineEnding {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== '\n') continue;
    if (i > 0 && source[i - 1] === '\r') crlf += 1;
    else lf += 1;
  }
  return crlf > lf ? 'crlf' : 'lf';
}

/** 打开 / 新建时确定的投影参数。 */
function frameForOpenedSource(source: string): ProjectionFrame {
  return { protectedLeadingFeff: source.startsWith(BYTE_ORDER_MARK), dominantEol: detectDominantEol(source) };
}

/**
 * 按冻结的 frame 构建投影。
 *
 * frame 与 source 不一致（声明了受保护前缀但 source 不以 U+FEFF 开头，或反之）说明会话不变量已被破坏，
 * 属于编辑器内部错误而不是调用方可触发的输入，直接抛出。
 */
export function buildProjection(source: string, frame: ProjectionFrame): SourceProjection {
  if (source.startsWith(BYTE_ORDER_MARK) !== frame.protectedLeadingFeff) {
    throw new Error('SourceProjection: frame.protectedLeadingFeff 与 exact source 不一致');
  }
  const protectedPrefixLength = frame.protectedLeadingFeff ? 1 : 0;
  const parts: string[] = [];
  const crlfSourceStarts: number[] = [];
  const loneCrSourceOffsets: number[] = [];
  let i = protectedPrefixLength;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\r' && source[i + 1] === '\n') {
      crlfSourceStarts.push(i);
      parts.push('\n');
      i += 2;
      continue;
    }
    if (ch === '\r') {
      loneCrSourceOffsets.push(i);
      parts.push(CR_PLACEHOLDER);
    } else if (ch !== undefined) {
      parts.push(ch);
    }
    i += 1;
  }
  return {
    source,
    view: parts.join(''),
    frame,
    protectedPrefixLength,
    crlfSourceStarts,
    loneCrSourceOffsets,
  };
}

/** 打开 / 新建时的投影：先确定 frame，再构建。 */
export function createInitialProjection(source: string): SourceProjection {
  return buildProjection(source, frameForOpenedSource(source));
}
