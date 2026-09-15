/**
 * JCX 文本 → 字节编码（M1.7 T1，方案 v1.1 §1/§2）。
 *
 * 架构守卫（`tests/unit/jcx/serialize/architecture.test.ts` 钉死）：本文件
 * 只允许 `import` `iconv-lite`、`../encoding/*` 与同目录的 `./types`——
 * 因此不 import `../lexer/diagnostics` 的 `JcxDiagnostic` 类型，
 * `EncodeJcxDiagnostic` 在本文件内结构等价地独立声明（不含 `path` 字段时
 * 仍可结构赋值给 `JcxDiagnostic`），T2 组装 `SerializeResult.diagnostics`
 * 时直接并入即可。`JcxUnencodableStrategy` 只在 `./types.ts` 声明一处，
 * 本文件从那里导入。
 *
 * 不可编码字符探测方式：**整段 encode→decode 回环比对，仅在不互逆时才
 * 逐码点定位**。GB18030（2005 版）按规范要求覆盖全部合法 Unicode 标量
 * 值——实测 iconv-lite 对 emoji、私用区（U+E000+）、U+FFFF 等均可正确往返
 * 编解码，真正会触发「不可编码」的只有孤立 surrogate（lone surrogate，
 * 本身就不是合法的 Unicode 标量值）。iconv-lite 未暴露「严格模式 / 遇不可
 * 编码字符即报错」的公开 API（`iconvEncode` 对不可映射输入静默写 `?` 而不
 * 抛异常），因此正常路径只做一次整段 `iconvEncode` + 一次整段
 * `iconvDecode` 并与原文比较（O(n)，2 次 iconv 调用）；只有比较不相等
 * （即存在不可编码字符）时，才逐码点比对定位第一个/全部坏字符的行列——
 * 此时 `iconvEncode` 已经把每个坏字符静默替换成 `?`（单字节），写入的
 * `fullEncoded` 本身就是正确的输出字节，不需要再重新拼接。
 */

import { decode as iconvDecode, encode as iconvEncode } from 'iconv-lite';

import { createJcxEncodingError } from '../encoding/decodeJcx';
import type { JcxEncoding } from '../encoding/types';
import type { JcxUnencodableStrategy } from './types';

interface EncodeJcxPosition {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

interface EncodeJcxSpan {
  readonly start: EncodeJcxPosition;
  readonly end: EncodeJcxPosition;
}

export interface EncodeJcxDiagnostic {
  readonly code: `jcx.serialize.${string}`;
  readonly severity: 'warning';
  readonly message: string;
  readonly span: EncodeJcxSpan;
}

export interface EncodeJcxOptions {
  readonly onUnencodable?: JcxUnencodableStrategy;
}

export interface EncodeJcxResult {
  readonly bytes: Uint8Array;
  readonly diagnostics: EncodeJcxDiagnostic[];
}

const REPLACEMENT_CHAR = '?';

/**
 * 与 `lexer/sourceSpan.ts` 的约定一致：`line` 1-based，仅 `\n` 触发换行
 * （CRLF 中的 `\r` 归属上一行）；`column` 0-based，单位是 UTF-16 code unit；
 * `offset` 同样是 UTF-16 code unit 偏移。不 import `sourceSpan.ts`（架构
 * 守卫），在此按同一约定独立实现。
 */
function computePosition(text: string, offset: number): EncodeJcxPosition {
  let line = 1;
  let column = 0;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === '\n') {
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
  }
  return { offset, line, column };
}

function formatCodePointLabel(codePoint: string): string {
  const scalar = codePoint.codePointAt(0) ?? 0;
  const hex = scalar.toString(16).toUpperCase().padStart(4, '0');
  return `${JSON.stringify(codePoint)} (U+${hex})`;
}

function encodeUtf8(text: string): EncodeJcxResult {
  // 文本首字符若已是 U+FEFF（preserve 解码时未剥离 BOM），原样编码即可
  // 得到 EF BB BF 开头的字节序列，不需要额外补 BOM（防止双 BOM）。
  return { bytes: new TextEncoder().encode(text), diagnostics: [] };
}

/**
 * 整段不互逆时，逐码点比对原文与「整段编码后再解码」的结果，定位每个坏
 * 字符（两者长度按码点数必然相等：每个原始码点要么被原样编解码，要么被
 * 替换成单个 `?`，都是一对一）。`onError` 用于 `'error'` 策略提前中断。
 */
function locateUnencodable(
  text: string,
  decodedBack: string,
  onBad: (codePoint: string, span: EncodeJcxSpan) => 'stop' | 'continue',
): void {
  const originalCodePoints = Array.from(text);
  const decodedCodePoints = Array.from(decodedBack);
  let offset = 0;

  for (let index = 0; index < originalCodePoints.length; index += 1) {
    const original = originalCodePoints[index] ?? '';
    const decoded = decodedCodePoints[index] ?? '';
    if (decoded !== original) {
      const span: EncodeJcxSpan = {
        start: computePosition(text, offset),
        end: computePosition(text, offset + original.length),
      };
      if (onBad(original, span) === 'stop') {
        return;
      }
    }
    offset += original.length;
  }
}

function encodeGb18030(text: string, strategy: JcxUnencodableStrategy): EncodeJcxResult {
  const encodedBuffer = iconvEncode(text, 'gb18030');
  const fullEncoded = new Uint8Array(encodedBuffer);
  const decodedBack = iconvDecode(encodedBuffer, 'gb18030');

  if (decodedBack === text) {
    return { bytes: fullEncoded, diagnostics: [] };
  }

  const diagnostics: EncodeJcxDiagnostic[] = [];
  let thrown: Error | undefined;

  locateUnencodable(text, decodedBack, (codePoint, span) => {
    if (strategy === 'error') {
      thrown = createJcxEncodingError(
        `Cannot encode character ${formatCodePointLabel(codePoint)} to GB18030 ` +
          `at line ${String(span.start.line)}, column ${String(span.start.column)}.`,
      );
      return 'stop';
    }

    diagnostics.push({
      code: 'jcx.serialize.unencodable-replaced',
      severity: 'warning',
      message:
        `Character ${formatCodePointLabel(codePoint)} cannot be encoded as GB18030; ` +
        `replaced with "${REPLACEMENT_CHAR}".`,
      span,
    });
    return 'continue';
  });

  if (thrown !== undefined) {
    throw thrown;
  }

  // fullEncoded 已经是 iconv-lite 对每个坏字符静默替换成 `?` 后的正确
  // 字节序列，无需重新拼接。
  return { bytes: fullEncoded, diagnostics };
}

/**
 * 把文本编码为字节。`utf-8` 直接用 `TextEncoder`；`gb18030` 经 iconv-lite，
 * 默认策略 `'error'`：遇到不可编码字符抛 `JcxEncodingError`（含首个坏字符
 * 及其行列，spec §27.2 不得静默丢字）；显式传入 `'replace'` 时写 `?` 并对
 * 每个不可编码字符产出一条 `jcx.serialize.unencodable-replaced` warning。
 */
export function encodeJcx(
  text: string,
  encoding: JcxEncoding,
  options?: EncodeJcxOptions,
): EncodeJcxResult {
  if (encoding === 'utf-8') {
    return encodeUtf8(text);
  }

  const strategy = options?.onUnencodable ?? 'error';
  return encodeGb18030(text, strategy);
}
