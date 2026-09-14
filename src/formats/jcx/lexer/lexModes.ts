/**
 * JCX Lexer —— voice style 预扫描 + 正文词法模式状态机（M1.4 方案 §3，docs/JCX_SPEC.md §13.2）。
 *
 * 背景：JCX 正文不是单一语言（§13.2）。`style=tab` 的声部用模式 B（弦/品），
 * 其余（`staff` / `jianpu` / 未知 / 缺省）用模式 A（音高）。因此 Lexer 必须
 * 在切分正文之前知道「当前行属于哪个声部、该声部是什么 style」。
 *
 * 难点是 `V:` 声明与 `[V:n]` 使用**不保证前后顺序**：§9.4 的语料样本里 `V:`
 * 字段行散布在 body 中间。所以本模块先做一次**全文预扫描**（`prescanVoices`），
 * 再用一个纯函数状态机（`createModeState` / `resolveMode`）流式消费行事件。
 *
 * 本模块不含任何 class（项目约束），状态是普通可变对象，变更集中在 `resolveMode`。
 */

import type { SourceSpan } from './sourceSpan';
import type { DiagnosticBag } from './diagnostics';
import type { JcxBodyMode } from './lexBody';

/** §12.6：spec 登记的三个 style 取值。大小写敏感 —— 见 `styleToMode` 注释。 */
export const KNOWN_VOICE_STYLES: readonly string[] = ['staff', 'jianpu', 'tab'];

const KNOWN_VOICE_STYLE_SET = new Set(KNOWN_VOICE_STYLES);

/** 单个 `V:` 声明的预扫描结果。 */
export interface VoiceStyleInfo {
  /** trim 后的 voice id 原文（§12.1：先 trim 再取 id）。 */
  readonly id: string;
  /** `style=` 的原始值（已去掉包裹引号）；缺省时为 `undefined`（§12.6.1）。 */
  readonly style?: string;
  /** `style=` 值本身的 span（用于把 unknown-style diagnostic 精确定位到属性值）。 */
  readonly styleSpan?: SourceSpan;
  /** `style` 值是否在 §12.6 登记表内。缺省 style 记为 `true`（不是「未知」，是「没写」）。 */
  readonly knownStyle: boolean;
  /** 该声部正文使用的词法模式（§13.2）。 */
  readonly mode: JcxBodyMode;
  /** 生效的 `style=` 所在行号（1-based）；§8.12 属性级覆盖后指向最后一次写 style 的行。 */
  readonly line: number;
}

export interface VoicePrescan {
  /** voice id → 声明信息。同 id 重复声明时**保留首次**（§8.12 的顺序保留交给 Parser）。 */
  readonly byId: ReadonlyMap<string, VoiceStyleInfo>;
  /** `V:` 的声明顺序（去重后），§9.4 的「第 k 段 ↔ 第 k 个声部」依赖它。 */
  readonly order: readonly string[];
  /** 全文是否出现过 `[V:...]` 内联字段 —— §9.4 的段落归属规则只在**没有**时启用。 */
  readonly hasInlineVoice: boolean;
}

/**
 * §12.6 + §12.6.5：把 `style=` 值映射为词法模式。
 *
 * **大小写敏感**：§12.6 只登记了小写的 `staff` / `jianpu` / `tab`，help 与语料
 * 亦全为小写，没有任何证据支持大小写不敏感匹配。因此 `style=TAB` 按 §12.6.5
 * 的「未知 style」处理 —— 保留原值、回退模式 A、发 warning，绝不报错。
 */
function styleToMode(style: string | undefined): { mode: JcxBodyMode; knownStyle: boolean } {
  if (style === undefined) {
    // §12.6.1：style 可选，缺省不是「未知」，不发 diagnostic，回退模式 A。
    return { mode: 'pitch', knownStyle: true };
  }
  if (!KNOWN_VOICE_STYLE_SET.has(style)) {
    return { mode: 'pitch', knownStyle: false };
  }
  return { mode: style === 'tab' ? 'tab' : 'pitch', knownStyle: true };
}

const WS_CHAR = /[ \t]/;

/**
 * 扫描 `V:` 行属性串，取出 `style=` 的值（§12.1 / §12.4）。
 *
 * 必须做真正的 `key=value` 扫描而不是 `/style=(\S+)/`：`name="a style=tab b"`
 * 里的 `style=` 落在引号内，不是属性。值以 `"` 开头时取到下一个 `"` 为止，
 * 否则取到下一个空白为止（§12.4 规范要求）。
 */
interface StyleAttrHit {
  readonly value: string;
  /** 值在 `attrs` 内的起止下标（不含包裹引号）。 */
  readonly valueStart: number;
  readonly valueEnd: number;
}

function extractStyleAttr(attrs: string): StyleAttrHit | undefined {
  let i = 0;
  while (i < attrs.length) {
    while (i < attrs.length && WS_CHAR.test(attrs[i] as string)) {
      i += 1;
    }
    const keyStart = i;
    while (i < attrs.length && !WS_CHAR.test(attrs[i] as string) && attrs[i] !== '=') {
      i += 1;
    }
    const key = attrs.slice(keyStart, i);

    if (attrs[i] !== '=') {
      // 无 `=` 的裸 token：不是属性，跳过继续扫下一个。
      continue;
    }
    i += 1; // 跳过 '='

    let value: string;
    let valueStart: number;
    let valueEnd: number;
    if (attrs[i] === '"') {
      const close = attrs.indexOf('"', i + 1);
      valueStart = i + 1;
      valueEnd = close === -1 ? attrs.length : close;
      value = attrs.slice(valueStart, valueEnd);
      i = close === -1 ? attrs.length : close + 1;
    } else {
      valueStart = i;
      while (i < attrs.length && !WS_CHAR.test(attrs[i] as string)) {
        i += 1;
      }
      valueEnd = i;
      value = attrs.slice(valueStart, valueEnd);
    }

    if (key === 'style') {
      return { value, valueStart, valueEnd };
    }
  }
  return undefined;
}

/** §12.1：`V:<id> [<attr> ...]`，容忍冒号后空白，id 不含空白。 */
const VOICE_FIELD_RE = /^[ \t]*V:[ \t]*(\S*)([^\r\n]*)$/;
/** §9.1 / §9.5：行首内联字段（与 lexDocument 的消歧规则一致，只看是否存在）。 */
const INLINE_VOICE_RE = /^[ \t]*\[[ \t]*V[ \t]*:/;
/** §5.7 / §10：`%%` 指令行（只需要认出 begintext / endtext）。 */
const PRESCAN_DIRECTIVE_RE = /^[ \t]*%%[ \t]*([A-Za-z0-9_-]*)/;
/** §5.6：`%` 注释行（含 `%%`，由上面的指令正则先行处理）。 */
const PRESCAN_COMMENT_RE = /^[ \t]*%/;

/**
 * 预扫描全文的 `V:` 声明（方案 §3 第 1 条）。
 *
 * 扫描的是**原始文本的全部行**而非 header 区 —— 因为 §9.4 的样本把 `V:` 写在
 * body 中间，只扫 header 会漏掉 9 个声部里的 8 个。
 *
 * 但必须与 §13.3 的行分类结论保持一致：**只有真会被分类成 field 行的 `V:` 才是
 * 声明**。因此本扫描复刻了两条压过一切的优先级：
 * - §11.3：`%%begintext`…`%%endtext` 之间的行一律是文本内容，块内的 `V: 副歌`
 *   是歌词/段落标题而不是声部声明，必须跳过；否则它会挤进 `order`，把 §9.4 的
 *   「第 k 段 ↔ 第 k 个声部」整体错位一格。
 * - §5.6：`%` 注释行同样不是声明（`V:` 正则本身已排除，这里显式短路以自证）。
 *
 * 不接收 `DiagnosticBag`：预扫描是纯查询，未知 style 的 warning 在
 * `resolveMode` 真正切换到该声部时才发，避免为从未使用的声明刷噪音。
 */
export function prescanVoices(text: string): VoicePrescan {
  const byId = new Map<string, VoiceStyleInfo>();
  const order: string[] = [];
  let hasInlineVoice = false;
  let inTextBlock = false;
  /** 当前行首在全文中的 offset，用于给 `style=` 值算出精确 span。 */
  let lineStart = 0;

  const rawLines = text.split('\n');
  for (let i = 0; i < rawLines.length; i += 1) {
    const rawLine = rawLines[i] as string;
    // 去掉 CRLF 的 `\r`，使行尾属性不被 `\r` 污染（`\r` 在行末，不影响列号）。
    const line = rawLine.replace(/\r$/, '');
    const currentLineStart = lineStart;
    lineStart += rawLine.length + 1;

    const directive = PRESCAN_DIRECTIVE_RE.exec(line);
    if (directive !== null) {
      const name = directive[1] as string;
      if (name === 'begintext') {
        inTextBlock = true;
      } else if (name === 'endtext') {
        inTextBlock = false;
      }
      continue;
    }
    // §11.3 / §5.6：文本块内容行与注释行都不是声明，也不是内联字段。
    if (inTextBlock || PRESCAN_COMMENT_RE.test(line)) {
      continue;
    }

    if (!hasInlineVoice && INLINE_VOICE_RE.test(line)) {
      hasInlineVoice = true;
    }

    const match = VOICE_FIELD_RE.exec(line);
    if (match === null) {
      continue;
    }

    const id = match[1] as string;
    const attrs = match[2] as string;
    const attrsStart = (match[0] as string).length - attrs.length;
    const hit = extractStyleAttr(attrs);
    const { mode, knownStyle } = styleToMode(hit?.value);

    const styleSpan: SourceSpan | undefined =
      hit === undefined
        ? undefined
        : {
            start: {
              offset: currentLineStart + attrsStart + hit.valueStart,
              line: i + 1,
              column: attrsStart + hit.valueStart,
            },
            end: {
              offset: currentLineStart + attrsStart + hit.valueEnd,
              line: i + 1,
              column: attrsStart + hit.valueEnd,
            },
          };

    const previous = byId.get(id);
    if (previous !== undefined && hit === undefined) {
      // §8.12 声部型：同 id 重复定义是**属性级**覆盖 —— 后者没写 style，
      // 前者的 style 依然有效，不得被「无 style」覆盖掉。
      continue;
    }

    byId.set(id, {
      id,
      ...(hit === undefined ? {} : { style: hit.value }),
      ...(styleSpan === undefined ? {} : { styleSpan }),
      knownStyle,
      mode,
      line: i + 1,
    });
    if (previous === undefined) {
      // `order` 反映**首次**声明位置：§9.4 的段落顺序推断依赖声明先后，
      // 而后续的重复声明只是覆盖属性，不构成一个新的声部。
      order.push(id);
    }
  }

  return { byId, order, hasInlineVoice };
}

/** 方案 §3 第 2 条：跨行携带的模式状态。 */
export interface ModeState {
  /** §6.2：header 区 = 文件开头到第一个 `K:` 行（含）。 */
  region: 'header' | 'body';
  /** 当前生效的声部 id；尚未切换过时为 `null`。 */
  currentVoiceId: string | null;
  /** 当前生效的正文词法模式（§13.2）；缺省模式 A。 */
  mode: JcxBodyMode;
  /** §9.4：body 中第 k 段正文对应第 k 个声明的声部；`-1` 表示尚未进入任何段落。 */
  segmentIndex: number;
  /** 已就未知 style 发过 warning 的声部 id，避免交替式文件里刷 24 条重复。 */
  readonly warnedUnknownStyle: Set<string>;
}

export function createModeState(): ModeState {
  return {
    region: 'header',
    currentVoiceId: null,
    mode: 'pitch',
    segmentIndex: -1,
    warnedUnknownStyle: new Set<string>(),
  };
}

/**
 * `resolveMode` 消费的行事件。
 *
 * - `inlineVoice`：遇到 `[V:id]`（§9.1）。
 * - `field`：遇到字段行；只有 `V:`（§9.4 段落推进）与 `K:`（§6.2 区域切换）有意义。
 * - `bodyLine`：正文行，只是查询当前模式，不改变状态。
 */
export type ModeEvent =
  | { readonly type: 'inlineVoice'; readonly id: string; readonly span: SourceSpan }
  /** `span` 指向该行的 `fieldKey` token（如 `V:` 的 `V`），不是整行。 */
  | { readonly type: 'field'; readonly key: string; readonly value: string; readonly span: SourceSpan }
  | { readonly type: 'bodyLine' };

function switchToVoice(
  state: ModeState,
  prescan: VoicePrescan,
  id: string,
  span: SourceSpan,
  bag: DiagnosticBag,
): JcxBodyMode {
  const info = prescan.byId.get(id);
  state.currentVoiceId = id;
  // 未声明的 id：§12.6.1 / §29 的宽容方向 —— 回退模式 A，不报错。
  state.mode = info?.mode ?? 'pitch';

  if (info !== undefined && !info.knownStyle && !state.warnedUnknownStyle.has(id)) {
    state.warnedUnknownStyle.add(id);
    // §12.6.5：未知 style 保留原值 + 回退默认，只发 warning。
    bag.report(
      'jcx.voice.unknown-style',
      'warning',
      `unknown voice style '${info.style ?? ''}' on 'V:${id}'; falling back to pitch-mode body lexing`,
      // 指向 `style=` 的值本身；预扫描一定给得出该 span（未知 style ⇒ 写了 style）。
      // 兜底用切换点 span，仅为类型收窄。
      info.styleSpan ?? span,
    );
  }

  return state.mode;
}

/**
 * 状态机的唯一入口：消费一个行事件并返回**该行之后生效**的正文词法模式。
 *
 * 永不抛异常；任何无法识别的写法一律回退模式 A（§13.2「`style` 缺省 → 模式 A」）。
 */
export function resolveMode(
  state: ModeState,
  prescan: VoicePrescan,
  event: ModeEvent,
  bag: DiagnosticBag,
): JcxBodyMode {
  switch (event.type) {
    case 'inlineVoice':
      // 方案 §3 第 3 条：`[V:id]` 是最强的切换信号。
      return switchToVoice(state, prescan, event.id, event.span, bag);

    case 'field': {
      if (event.key === 'K' && state.region === 'header') {
        // §6.2：`K:` 是 header 的最后一个字段，其后即 body。
        state.region = 'body';
        return state.mode;
      }

      if (event.key !== 'V') {
        return state.mode;
      }

      if (prescan.hasInlineVoice || state.region !== 'body') {
        // header 区的 `V:` 只是声明；用了 `[V:...]` 的文件不走 §9.4 顺序推进。
        return state.mode;
      }

      // §9.4（INFERRED，单样本）：body 中每个 `V:` 行开启第 k 段正文，
      // 按 **声明顺序** 而非行内 id 归属 —— 这正是该条推断规则的内容。
      state.segmentIndex += 1;
      const byOrder = prescan.order[state.segmentIndex];
      const declaredId = event.value.trim().split(/[ \t]/)[0] ?? '';
      const id = byOrder ?? declaredId;

      bag.report(
        'jcx.voice.segment-by-order',
        'info',
        `body 'V:' field starts paragraph #${state.segmentIndex + 1}; assigned to voice '${id}' by declaration order (JCX_SPEC §9.4, single-sample inference)`,
        event.span,
      );

      return switchToVoice(state, prescan, id, event.span, bag);
    }

    case 'bodyLine':
    default:
      return state.mode;
  }
}
