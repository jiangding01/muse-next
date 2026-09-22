/**
 * notation/model —— 渲染层诊断通道（M2 方案 v1.1.1 §4.2）。
 *
 * 层次归属（硬规则，守卫测试钉死）：
 * - `RenderDiagnostic` **只属于 notation/render 层**：不回写 `Score`、不转换成
 *   `JcxDiagnostic`、不混入 store 里的 `diagnostics` 数组。
 * - 反向同样禁止：不得把 `JcxDiagnostic` 重新包装成 `RenderDiagnostic`；同一件事
 *   只由一层报告一次（例如悬空 strokePrefix 已由 lexer 报过，渲染层不重复报）。
 * - code 一律 `muse.render.*` 前缀，**绝不与 `jcx.*` 混用**。
 * - 类型（`RenderDiagnostic` / `Anchor` / code / level）住在 `types.ts`，本文件只放
 *   **构造与收集**，依赖方向单向 `diagnostics.ts → types.ts`，无循环。
 * - **渲染层永不产生 error 级**：`loadJcx` 保证永远有一个可渲染的 `Score`，渲染层
 *   同样保证永远画得出一页谱，最坏情况是一页全是未知占位块。
 *
 * **T1 hygiene 的唯一变更**：`RENDER_DIAGNOSTIC_CODES` 收编了
 * `relationEndpointMissing`——它在 T1 实现期曾临时定义在 `relations.ts` 局部，
 * 违反「code 常量表是唯一来源」。本次把它并回表内，`relations.ts` 改为引用本表。
 * 除此之外本文件相对 T0 没有任何改动（类型形状、构造函数、id 派生规则全部照旧）。
 */

import type { RenderDiagnostic, RenderDiagnosticCode } from './types';
import { anchorKey } from './types';

/** 构造诊断的入参：`id` 由 `collectRenderDiagnostics` 确定性派生，调用方不自造。 */
export type RenderDiagnosticDraft = Omit<RenderDiagnostic, 'id'>;

/**
 * T0 就位的 code 常量表（后续任务按需追加，**唯一来源**）。
 * 每条都对应方案里一处明确写死的语义，不允许实现层临时拼字符串。
 */
export const RENDER_DIAGNOSTIC_CODES = {
  /**
   * `duration` 无法表示为 `base × {1, 3/2, 7/4}`（如 `1/3`、`5/16`）：
   * 不画任何时值装饰，宽度按字面 `duration` 排布（§2.6.1）。
   */
  durationUnrepresentable: 'muse.render.duration.unrepresentable',
  /** `L:` 不可知导致 `duration` 缺失：固定宽 fallback + 所在 measure 退等距（§2.6.1 / R4）。 */
  durationUnresolved: 'muse.render.duration.unresolved',
  /** tuplet 实际时值关系未建模，成员按字面时值排布；挂在关系上，不挂成员（§2.6.1，P1-C）。 */
  tupletTimingNotModeled: 'muse.render.tuplet.timing-not-modeled',
  /** `style` 缺席——作者没写（§3.0）。 */
  voiceStyleAbsent: 'muse.render.voice.style-absent',
  /** `style` 是我们不认识的值——与「没写」是两个不同事实，**不得合并**（§3.0）。 */
  voiceStyleUnknown: 'muse.render.voice.style-unknown',
  /**
   * 关系的某个端点（`from` / `to` / `member` 任一）在传入的 `DomainIndex` 里指不到
   * 有效目标：事件查不到，或事件在但 `memberIndex` 对它无效。
   *
   * **只用于 index / Domain 不变量被破坏的情形**，不用于 parse 层如实记录的恢复状态
   * （`tie.unresolved` / `slur.unclosed` / `tuplet.incomplete` 是正常的源文本事实，
   * 不是错误，不发这条）。成因由 `relations.ts` 的 `DanglingReason` 区分。
   */
  relationEndpointMissing: 'muse.render.relation.endpoint-missing',
  /**
   * T4 追加（layout 层，全部挂 `event` / `relation` / `document` 分支的 anchor）。
   * 追加到本表而不是就地拼字符串，是为了守住「code 常量表是唯一来源」。
   */
  /** `octaveShift` 缺失但 `octaveRaw` 非空（混合方向 `C,'`，U23）：只按 `register` 画基准八度（§3.2）。 */
  jianpuOctaveMixed: 'muse.render.jianpu.octave-mixed',
  /** 简谱声部里出现了不属于简谱范围的事件（如 TAB 事件）：画可见占位，不静默丢弃。 */
  jianpuEventOutOfScope: 'muse.render.jianpu.event-out-of-scope',
  /** `UnknownEvent` 的可见占位（C1：恰好一个节点；C2：至少一条诊断）。 */
  eventUnknown: 'muse.render.event.unknown',
  /** 休止 `Z`（U24）：按普通休止画 `0`，**不画多小节休止、不占多小节宽度**（§3.2）。 */
  restMultiMeasureNotModeled: 'muse.render.rest.multi-measure-not-modeled',
  /** 休止 `@`（§15.3）：照常画并占位，**绝不隐藏**（隐藏才是猜测）（§3.2）。 */
  restInvisibleNotModeled: 'muse.render.rest.invisible-not-modeled',
  /** tuplet 的 `q` 缺失或为 `0`（U25）：只画括号 + `p` 数字，不做任何时值缩放（§3.2）。 */
  tupletRatioUnverified: 'muse.render.tuplet.ratio-unverified',
  /** `tuplet.status === 'incomplete'`：括号按已有成员范围画，缺失端不补（§3.2）。 */
  tupletIncomplete: 'muse.render.tuplet.incomplete',
  /** `tie.status === 'unresolved'`：画半开弧（悬空端）（§3.2，A 类恢复状态）。 */
  tieUnresolved: 'muse.render.tie.unresolved',
  /** `slur.status === 'unclosed'`：同上，弧画在数字上方（§3.2，A 类恢复状态）。 */
  slurUnclosed: 'muse.render.slur.unclosed',
  /** `BarlineEvent.raw` 不在 §18 的已知形态表内：画普通单线（§3.2）。 */
  barlineUnrecognized: 'muse.render.barline.unrecognized',
  /** `K:` 的 `tonic` 有值但 mode 不是已知模式（`DOC-ONLY`）：mode 原文一并显示，**不假设 major**（§3.2）。 */
  keyModeUnrecognized: 'muse.render.key.mode-unrecognized',
  /** `K:` 只有 `raw`、`tonic` 缺失：原样转述 `K: <raw>`，**不从 `alter` 反推主音**（§3.2）。 */
  keyUnresolved: 'muse.render.key.unresolved',
  /** `Score.key` 整个缺席：**不画调号标签**（默认调号无证据，§8.7）（§3.2）。 */
  keyAbsent: 'muse.render.key.absent',
  /** `Meter` 是 `raw` 分支（`C` / `C|`）：原样显示 raw 文本，**不换算成 4/4**（§3.2）。 */
  meterRaw: 'muse.render.meter.raw',
  /** 歌词里的 `-` / `_` / `|` 在 Domain 里是普通字符（U31/U32）：原样输出，不做连字符/延长线语义（§3.2）。 */
  lyricMarkerLiteral: 'muse.render.lyric.marker-literal',
  /** 歌词音节没有 `target`（或 target 不在本声部）：不对齐到任何列，按顺序落在行尾（§3.2）。 */
  lyricTargetMissing: 'muse.render.lyric.target-missing',
  /** `DecorationEvent`：只画统一文本占位，**不做符号字形映射**（U27–U30）（§3.2）。 */
  decorationPlaceholder: 'muse.render.decoration.placeholder',
  /** body 内 `L:` 变化点：画一个细标记；渲染直接用已解算好的 `duration`，不重新解释作用域（§3.2）。 */
  unitLengthChanged: 'muse.render.unit-length.changed',
  /**
   * T6.1 追加（`notation/tab/**`）：pitch 模式事件（`note` / `chord`）出现在 TAB 声部里
   * —— 画可见文本占位，**不静默丢弃**，也不把音高猜成某根弦的某个品位（spec §26.10：
   * TAB 模式下小写字母是弦号、前置大写字母是拨弦方向，音高与弦品之间没有可逆映射）。
   *
   * 与简谱侧的 `jianpuEventOutOfScope` **分列两条**：两者是两个方向的越界，合并成一条
   * 就无法从诊断本身看出是哪种记谱收到了不属于它的事件。
   *
   * 注：**没有**对应的「弦号越界」code——`TabNote.stringIndex` 在 Domain 里就是
   * `1 | 2 | 3 | 4 | 5 | 6` 的字面量联合，1..6 由类型保证，防御性 code 不可达。
   */
  tabEventOutOfScope: 'muse.render.tab.event-out-of-scope',
  /**
   * T6.1 追加：同一个 `tabGroup` / TAB 倚音里有**多个成员落在同一根弦上**
   * （如 `[a0/a3/]`）。一根弦在同一时刻只发得出一个音，这组写法在演奏上无法实现；
   * 但哪一个「有效」没有任何依据（spec §26 未描述这种写法，语料也未观察到），
   * 因此**全部照画**（视觉上会重叠）+ 一条 warning，不静默丢弃、也不挑一个留下。
   */
  tabGroupDuplicateString: 'muse.render.tab.group-duplicate-string',
  /**
   * T5 追加（`notation/layout/scoreHeader.ts`，document 级）：`Score.textBlocks`
   * 里 `closed === false` 的文本块——照常渲染已捕获的内容，不截断也不报错。**只有
   * 头部布局报告这件事**：任何记谱类型的头部标签（如简谱的 `K:`/拍号）都不覆盖
   * `textBlocks`，因此不存在与别处重复发诊断的风险（§4.2「同一件事只由一层报告一次」）。
   */
  textBlockUnclosed: 'muse.render.text-block.unclosed',
  /**
   * T6.3 追加（`notation/tab/tabStrokes.ts`）：独立 `H` 前缀按「延长」解释是 spec
   * §26.4 的 `INFERRED`（I15）位置消歧——H 既可能是「敲击」也可能是「延长」，本层
   * 保守取「延长」这一解释并如实标注，不静默。
   */
  tabStrokeHoldInferred: 'muse.render.tab.stroke-hold-inferred',
  /** stroke 字符不在 help 符号表（`V`/`U`/`A`/`B`/`P`/`H`/`'`/`S`/`T`）内：仍画原字符（可见），不猜语义。 */
  tabStrokeUnrecognized: 'muse.render.tab.stroke-unrecognized',
  /**
   * 每个 TAB 声部恰好一条（anchor 为 voice）：M2 的 TAB 渲染支持单音级的扫弦/拨弦
   * 方向记号（`TabNote.stroke`，parse 层已填充），不支持组级的方向记号
   * （`TabGroupEvent.stroke`，parse 层从不填充，M1.8 已知限制②）；组级前缀
   * （如 `V[...]`）在谱面上不显示。
   */
  tabGroupStrokeNotModeled: 'muse.render.tab.group-stroke-not-modeled',
  /**
   * T7.1 追加（`notation/staff/**`）：以下九条覆盖 Staff（五线谱）记谱的降级/越界
   * 事实，命名与 level 沿用 jianpu/tab 既有约定（`Not-modeled` info、越界/无法识别
   * warning，事件级挂 `event`，声部级挂 `voice`）。
   */
  /** 声部缺 `clef` 信息：Staff 布局用默认谱号兜底，作者没写（info，类比 `voiceStyleAbsent`）。 */
  staffClefAbsent: 'muse.render.staff.clef-absent',
  /** `clef` 有值但不在已知谱号表内：原样透传/降级为默认谱号（warning，语义与「没写」不同，不得合并）。 */
  staffClefUnrecognized: 'muse.render.staff.clef-unrecognized',
  /** Staff 声部里出现了不属于本记谱范围的事件（如 TAB 专属事件）：画可见占位，不静默丢弃。 */
  staffEventOutOfScope: 'muse.render.staff.event-out-of-scope',
  /** `octaveShift` 缺失但 `octaveRaw` 非空（混合方向 UNVERIFIED，spec §14.2）：只按 `register` 定基准八度。 */
  staffOctaveMixed: 'muse.render.staff.octave-mixed',
  /** `toStaffDuration` 返回 `beyondGlyphRange`：时值细过本层收紧的 glyph 范围上限（128th），不画具体符头。 */
  staffDurationBeyondGlyphRange: 'muse.render.staff.duration-beyond-glyph-range',
  /** `GraceEvent`：倚音未建模专属几何，仅按普通音符降级占位；逐条发（anchor=event）。 */
  staffGraceNotModeled: 'muse.render.staff.grace-not-modeled',
  /** 圆滑线（slur）关系未建模：声部级发一次（anchor=voice），不逐条挂在每个成员上。 */
  staffSlurNotModeled: 'muse.render.staff.slur-not-modeled',
  /** 歌词未建模：声部级发一次（anchor=voice）。 */
  staffLyricsNotModeled: 'muse.render.staff.lyrics-not-modeled',
  /** 和弦块成员里的休止（`Note | Rest` 联合里的 `Rest` 分支）未单独建模：随和弦整体降级占位。 */
  staffChordMemberRestNotModeled: 'muse.render.staff.chord-member-rest-not-modeled',
} as const satisfies Record<string, RenderDiagnosticCode>;

/** 纯构造：给定 draft 与序号，得到最终诊断。`ordinal` 只参与 id，不参与语义。 */
export function renderDiagnostic(draft: RenderDiagnosticDraft, ordinal: number): RenderDiagnostic {
  const id = `${anchorKey(draft.anchor)}|${draft.code}#${String(ordinal)}`;
  return draft.sourceRef === undefined
    ? { id, code: draft.code, level: draft.level, message: draft.message, anchor: draft.anchor }
    : {
        id,
        code: draft.code,
        level: draft.level,
        message: draft.message,
        anchor: draft.anchor,
        sourceRef: draft.sourceRef,
      };
}

/**
 * 收集 helper：按给定顺序给每条 draft 派生稳定 id。
 *
 * 同一 `(anchor, code)` 出现多次是**允许的**（C2 是「至少一条」而不是「恰好一条」），
 * 序号按出现次序递增，因此同一输入序列必然得到同一批 id。
 */
export function collectRenderDiagnostics(
  drafts: readonly RenderDiagnosticDraft[],
): readonly RenderDiagnostic[] {
  const seen = new Map<string, number>();
  return drafts.map((draft) => {
    const key = `${anchorKey(draft.anchor)}|${draft.code}`;
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    return renderDiagnostic(draft, ordinal);
  });
}
