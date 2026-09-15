/**
 * Parse 层 —— `%%gchord` 值解析（M1.6 T9；spec §10.1，方案 v1.1 §1.4 / §2）。
 *
 * 纯函数，不发 diagnostic：调用方（`directives.ts`）负责在返回 `undefined`
 * 时上报 `jcx.parse.gchord.malformed`。
 *
 * 语法（spec §10.1，help 转述）：
 * `<和弦名>=<变调夹品位>;<第六弦>,<第五弦>,<第四弦>,<第三弦>,<第二弦>,<第一弦>`
 *
 * 每个弦位三种形态：`X`/`x` 禁弹、`0` 空弦、`<品位 1-24>` 或 `<品位 1-24>(<手指号 1-4>)`。
 * `0` 只允许出现在「空弦」位置，不是合法的 capo 值——capo 与 fret 是两套互不相通的
 * 取值范围（用户 2026-09-15 追加约束①，覆盖此前「非负整数」的宽松判断）。
 * 横按（§10.1 未解决点 1）与非 6 弦（未解决点 2）都是 `UNVERIFIED`，不发明语法：
 * 项数 ≠ 6、capo 越界（不在 1–20）、fret 越界（不在 1–24）、finger 越界（不在 1–4）、
 * 任一弦位不合法（如 `X(1)`）均判定整条解析失败，只返回 `undefined`，不做区间外的猜测截断。
 */

import type { GuitarChord, GuitarFinger, GuitarString, SourceRef } from '../../../domain';

/** `<name>=<capo>;<六个弦位，逗号分隔>`。三个捕获组分别对应名字 / capo / 弦位串。 */
const GCHORD_RE = /^([^=]*)=([^;]*);(.*)$/;

/**
 * capo（变调夹品位）：spec §10.1「`=` 后数字，取值 1–20」，`CONFIRMED`（help）。
 * `0` 不是合法 capo（那是弦位「空弦」的记法，两者不共享 0）。
 */
const CAPO_RE = /^([1-9]|1\d|20)$/;

/** §10.1 与语料只 CONFIRMED 大写 `X`；小写 `x` 无证据，不认（不做大小写宽容）。 */
const MUTED_RE = /^X$/;
const OPEN_RE = /^0$/;

/**
 * `<品位 1-24>` 或 `<品位 1-24>(<单个数字手指号>)`；spec §10.1「`1`–`24` 品位数字」。
 * 手指号越界、多位数字（如 `(12)`）或品位越界都在后续显式区间校验中判定弦位不合法。
 */
const FRETTED_RE = /^([1-9]\d?)(?:\((\d)\))?$/;

function isGuitarFinger(n: number): n is GuitarFinger {
  return n === 1 || n === 2 || n === 3 || n === 4;
}

/** 单个弦位 token（逗号分隔的一段，未 trim）→ `GuitarString`；不合法返回 `undefined`。 */
function parseStringToken(token: string): GuitarString | undefined {
  const trimmed = token.trim();

  if (MUTED_RE.test(trimmed)) {
    return { state: 'muted', fret: null };
  }
  if (OPEN_RE.test(trimmed)) {
    return { state: 'open', fret: 0 };
  }

  const match = FRETTED_RE.exec(trimmed);
  if (match === null) {
    return undefined;
  }
  const fretRaw = match[1] ?? '';
  const fret = Number(fretRaw);
  if (!Number.isSafeInteger(fret) || fret < 1 || fret > 24) {
    // spec §10.1：品位数字取值 1–24，越界（如 25）判定该弦位不合法，不截断、不夹紧。
    return undefined;
  }

  const fingerRaw = match[2];
  if (fingerRaw === undefined) {
    return { state: 'fretted', fret };
  }
  const finger = Number(fingerRaw);
  if (!isGuitarFinger(finger)) {
    // f 只接受 1–4（spec §10.1：食指/中指/无名指/小指），其余（含 0、5–9）判定整条不合法。
    return undefined;
  }
  return { state: 'fretted', fret, finger };
}

/**
 * 解析一条 `%%gchord` 的值部分（不含 `%%gchord ` 前缀）。
 *
 * `origin` 由调用方从对应 `directiveLine` 节点取得——本函数不重扫 AST，只做
 * 字符串层面的语法解析，纯函数、不产生副作用。
 */
export function parseGChordValue(raw: string, origin: SourceRef): GuitarChord | undefined {
  const match = GCHORD_RE.exec(raw);
  if (match === null) {
    return undefined;
  }

  const name = (match[1] ?? '').trim();
  if (name.length === 0) {
    return undefined;
  }

  const capoRaw = (match[2] ?? '').trim();
  if (!CAPO_RE.test(capoRaw)) {
    // spec §10.1：capo 取值 1–20；`0` 或 21+ 越界，整条判定失败（用户约束①）。
    return undefined;
  }
  const capoFret = Number(capoRaw);

  const tokens = (match[3] ?? '').split(',');
  if (tokens.length !== 6) {
    return undefined;
  }

  const strings: GuitarString[] = [];
  for (const token of tokens) {
    const parsed = parseStringToken(token);
    if (parsed === undefined) {
      return undefined;
    }
    strings.push(parsed);
  }
  const [s6, s5, s4, s3, s2, s1] = strings;
  if (
    s6 === undefined ||
    s5 === undefined ||
    s4 === undefined ||
    s3 === undefined ||
    s2 === undefined ||
    s1 === undefined
  ) {
    return undefined;
  }

  return {
    name,
    capoFret,
    strings: [s6, s5, s4, s3, s2, s1],
    barres: [],
    rawValue: raw,
    origin,
  };
}
