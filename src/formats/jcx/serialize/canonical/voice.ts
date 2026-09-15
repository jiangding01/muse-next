/**
 * canonical 序列化 —— `V:` 声明行（M1.7 T3，方案 v1.1 §3 / §8 拍板 C·F）。
 *
 * **声部 id**：Domain 的 `VoiceId` 由 `voiceId(n)` 按**声明序号**生成
 * （`ids.ts`：`v1`、`v2`…），**原始 JCX id 没有被保存在 `Voice` 上**
 * （`V:A` 与 `V:1` 在 Domain 里都会变成 `v1`；spec §12.1 记载 27/27 语料为
 * 纯数字，非数字 id 为 DOC-ONLY）。因此 canonical 只能用声明序号回写，
 * 即 `v1 → V:1`（拍板 F：没有事实信息就不猜）。T4 的行内 `[V:n]` 必须复用
 * 本文件导出的 `canonicalVoiceLabel`，两处不得各写一份规则。
 *
 * **属性拼写**（拍板 C，覆盖 spec §27.3「canonical 仍用原始拼写」那一行——
 * Domain 已经把别名归一化掉了，原始拼写在 Domain → 文本方向不可得）：
 * `ins=` / `vol=` 用拍板 C 指定的 CONFIRMED 短别名；`name=` / `bracket=` /
 * `style=` / `clef=` 用语料 CONFIRMED 的全称。`sname` / `brace` / `staves` /
 * `space` 与它们的短别名（`snm` / `brc` / `stv` / `spc`）**同为 DOC-ONLY、
 * 语料计数同为 0**——证据等同时取**全称**，因为全称是 help 属性总表的写法
 * （用户 2026-09-15 裁决②）。绝不输出 UNVERIFIED 的 `volume=`。
 *
 * **属性顺序**固定为 `name sname style clef ins vol bracket brace staves space`
 * （spec §12.1：原版属性顺序不固定，Domain 也不保存顺序，故 canonical 固定一种）；
 * 其后按原序、原拼写写出 `unknownAttributes`（含 `play=1` 这类 UNVERIFIED 属性）。
 *
 * **`gchords` 不回写**：spec §12.2 的 `<bool>` 字面值编码全文未定义，parse 层
 * 因此从不填 `Voice.gchords`，而是把 `gchords=<raw>` 原样留在 `unknownAttributes`
 * 里（见 `parse/voice.ts` 文件头）。canonical 只回写 `unknownAttributes` 中已有的
 * 那一项；若 `Voice.gchords` 有值而 `unknownAttributes` 没有对应项，说明原文来源
 * 已丢失，不猜字面值、不输出（§9 第 1 条：UNVERIFIED 语义不得进入序列化行为）。
 *
 * **引号**（spec §12.4，grammar 无 escape 机制）：
 * | 值的形态 | 输出 | 理由 |
 * | --- | --- | --- |
 * | 不含空白 | 不加引号（**即使含 `"`**） | 解析取到下一个空白为止，原样回读无损 |
 * | 含空白、不含 `"` | `key="值"` | 唯一能表达空白的写法 |
 * | 含空白**且**含 `"` | 原样输出 + warning | 无可靠编码，不得猜 escape |
 */

import type { Voice, VoiceId } from '../../../../domain';

/**
 * 结构等价于 `JcxDiagnostic`（`../../lexer/diagnostics`）的本地声明——
 * 架构守卫禁止 `canonical/**` import lexer，与 `encodeJcx.ts` 同一手法。
 *
 * `span` 恒为零 span，**它是哨兵值、不是定位信息**：Domain 不保存 `SourceSpan`
 * （`SourceRef` 只是 AstPath 字符串），canonical 方向也没有「源位置」可言。
 * 消费者（编辑器、诊断面板）定位一律以 `path` 为准，不得读这个 `span`。
 */
export interface CanonicalDiagnostic {
  readonly code: `jcx.serialize.${string}`;
  readonly severity: 'warning';
  readonly message: string;
  readonly span: {
    readonly start: { readonly offset: number; readonly line: number; readonly column: number };
    readonly end: { readonly offset: number; readonly line: number; readonly column: number };
  };
  readonly path?: string;
}

const ZERO_POSITION = { offset: 0, line: 1, column: 0 };
const ZERO_SPAN = { start: ZERO_POSITION, end: ZERO_POSITION };

export interface VoiceDeclaration {
  readonly line: string;
  readonly diagnostics: readonly CanonicalDiagnostic[];
}

interface AttributeSpec {
  /** canonical 输出用的拼写（拍板 C）。 */
  readonly key: string;
  readonly read: (voice: Voice) => string | undefined;
}

function numeric(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

const ATTRIBUTE_ORDER: readonly AttributeSpec[] = [
  { key: 'name', read: (voice) => voice.name },
  { key: 'sname', read: (voice) => voice.sname },
  { key: 'style', read: (voice) => voice.style },
  { key: 'clef', read: (voice) => voice.clef },
  { key: 'ins', read: (voice) => numeric(voice.instrument) },
  { key: 'vol', read: (voice) => numeric(voice.volume) },
  { key: 'bracket', read: (voice) => numeric(voice.bracket) },
  { key: 'brace', read: (voice) => numeric(voice.brace) },
  { key: 'staves', read: (voice) => numeric(voice.staves) },
  { key: 'space', read: (voice) => voice.space },
];

/**
 * `VoiceId` → `V:` / `[V:…]` 里写的 id 文本：`v1 → 1`。
 * T4 的行内声部切换必须复用本函数（见文件头）。
 */
export function canonicalVoiceLabel(id: VoiceId): string {
  return id.startsWith('v') ? id.slice(1) : id;
}

interface RenderedValue {
  readonly text: string;
  /** 值同时含空白与 `"`，当前 grammar 无法无损编码。 */
  readonly unencodable: boolean;
}

function renderValue(value: string): RenderedValue {
  if (!/\s/.test(value)) {
    return { text: value, unencodable: false };
  }
  if (value.includes('"')) {
    return { text: value, unencodable: true };
  }
  return { text: `"${value}"`, unencodable: false };
}

/** 渲染单个声部的 `V:` 声明行（不含 body）。 */
export function renderVoiceDeclaration(voice: Voice): VoiceDeclaration {
  const parts: string[] = [`V:${canonicalVoiceLabel(voice.id)}`];
  const diagnostics: CanonicalDiagnostic[] = [];

  const emit = (key: string, value: string): void => {
    const rendered = renderValue(value);
    if (rendered.unencodable) {
      diagnostics.push({
        code: 'jcx.serialize.voice-value-unencodable',
        severity: 'warning',
        message:
          `声部 ${voice.id} 的属性 ${key} 的值同时含空白与双引号，` +
          `JCX 的 V: 属性语法没有转义机制（spec §12.4），canonical 原样输出该值，` +
          `重新解析时会被截断或落入 unparsed（本条诊断的 span 是哨兵零值，请以 path 定位）`,
        span: ZERO_SPAN,
        ...(voice.origins[0] === undefined ? {} : { path: voice.origins[0] }),
      });
    }
    parts.push(`${key}=${rendered.text}`);
  };

  for (const spec of ATTRIBUTE_ORDER) {
    const value = spec.read(voice);
    if (value !== undefined) {
      emit(spec.key, value);
    }
  }
  // 未识别属性：原序、原拼写（spec §12.2 的 `play=`、以及 `gchords=` 都在这里）。
  for (const attribute of voice.unknownAttributes) {
    emit(attribute.key, attribute.value);
  }

  return { line: parts.join(' '), diagnostics };
}
