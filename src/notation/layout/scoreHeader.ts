/**
 * notation/layout —— `Score` → `ScoreHeaderLayout`（M2 方案 v1.1.1 §3.5 / §2.2，T5，P2-11 / P2-E）。
 *
 * 打开一份乐谱，第一眼看到的不是音符而是标题——这是一个**薄布局**，独立于四种记谱
 * 各自的 layout model（§2.7 同源精神：它不是跨记谱复用的几何 primitive，不进
 * `primitives.ts`）。
 *
 * **输出路径明确为 HTML**（P2-E）：本文件只产出纯数据，由 `ScoreView` 用普通 React /
 * HTML 渲染，**不进 notation 的 SVG 树，不建任何 `toSvg`**——标题/credits/notes 是
 * 纯文本，HTML 排版天然可选中、可换行、可无障碍朗读，塞进 SVG 反而要自己实现一遍。
 * `M5` 导出 SVG/PDF 时需要这些字段另行进入 SVG 树，届时给本文件补一个 emit 函数即可
 * （布局早已算好），M2 不预留这条没有真实消费方的路径。
 *
 * `TextMeasurer` 度量的 `width`/`fontSize` 是 abstract unit（D6），**只为 M5 的
 * `toSvg` 预留**——`ScoreView` 消费本文件产出时只看 `.text` 字符串，视觉字号由
 * `global.css` 按语义 class 决定，不得把这里的数值当 CSS px 写进内联样式。
 *
 * **`key`/`meter` 的 fallback 诊断只在这里发一次**（T5 修订）：`Score.key` /
 * `Score.meter` 是文档级事实，与声部数量无关——一份乐谱可能有多个 `style=jianpu`
 * 声部，若每个声部各自的头部标签（`jianpu/jianpuSections.ts` 的
 * `buildHeaderLabels`）都各发一遍 `key.absent` 之类的诊断，同一件事就会被报告 N
 * 次。因此 `buildHeaderLabels` 现在**只画标签文本，不产生诊断**，`key.absent` /
 * `key.unresolved` / `key.mode-unrecognized` / `meter.raw` 全部改为本文件在文档级
 * 发一次。加上本文件独有的 `Score.textBlocks` 未闭合诊断，`layoutScoreHeader` 是
 * 这四类 + 文本块诊断的**唯一来源**，`ScoreView` 合并各层诊断时按 `id` 去重仍然是
 * 兜底，不是依赖它来消除重复。
 */

import type { KeySignature, Meter, Score, Tempo, TextBlock } from '../../domain';
import { keyHasExtraText } from './keySpelling';
import type { RenderDiagnosticDraft } from '../model/diagnostics';
import { RENDER_DIAGNOSTIC_CODES as CODES, collectRenderDiagnostics } from '../model/diagnostics';
import type { Anchor, RenderDiagnostic } from '../model/types';
import { SCORE_HEADER_METRICS } from './metrics';
import type { TextMeasurer } from './textMeasurer';

/** 一行头部文本的度量结果；`width`/`fontSize` 是 abstract unit，只为 M5 预留（见文件头）。 */
export interface ScoreHeaderTextLine {
  readonly text: string;
  readonly fontSize: number;
  readonly width: number;
}

export interface ScoreHeaderTextBlockLayout {
  readonly lines: readonly ScoreHeaderTextLine[];
  /** 原样携带 `TextBlock.closed`：为假时诊断已在本文件发出，此处只是让调用方也能读到事实。 */
  readonly closed: boolean;
}

export interface ScoreHeaderLayout {
  /** `Score.titles[0]`；`titles` 整体缺席时省略（不臆造 "Untitled"，那是 renderer 的展示决定）。 */
  readonly title?: ScoreHeaderTextLine;
  /** `Score.titles[1..]`：**多条保持有序、逐行渲染，不拼接**（§8.12）。 */
  readonly subtitles: readonly ScoreHeaderTextLine[];
  readonly credits: readonly ScoreHeaderTextLine[];
  readonly notes: readonly ScoreHeaderTextLine[];
  readonly key?: ScoreHeaderTextLine;
  readonly meter?: ScoreHeaderTextLine;
  readonly tempo?: ScoreHeaderTextLine;
  readonly textBlocks: readonly ScoreHeaderTextBlockLayout[];
  /** 只含「头部自己独有」的诊断（文本块未闭合）；不含 key/meter/tempo 的 fallback 诊断（见文件头）。 */
  readonly diagnostics: readonly RenderDiagnostic[];
}

const DOCUMENT_ANCHOR: Anchor = { kind: 'document' };

function line(text: string, fontSize: number, measurer: TextMeasurer): ScoreHeaderTextLine {
  return { text, fontSize, width: measurer.measure(text, { fontSize }).width };
}

/**
 * `K: <值>` 风格的原始调号转述（§3.2，与简谱声部头部标签同一规则）：**不生成
 * `1=<tonic>`**（P1-2）。四形态 fallback 诊断在这里**唯一**发出（见文件头）：
 * - `key` 缺席 → `key.absent`（info，默认调号无证据，spec §8.7）；
 * - `tonic` 缺失 → `key.unresolved`（warning，**不从 `alter` 反推主音**）；
 * - `raw` 含未识别的调式文本 → `key.mode-unrecognized`（info，**不假设 major**）；
 * - `tonic` 有值且 `raw` 里没有规范拼写以外的文本 → 无诊断。
 *
 * **T7.4 修正**：第三态原先写的是 `key.raw.trim() !== key.tonic`，它**没把 `alter`
 * 算进来**——`K:Eb` 的 `tonic` 是 `E`、`alter` 是 `-1`，`raw.trim()`（`Eb`）当然不等于
 * `E`，于是一个干净的降 E 调被误报成「含未识别的调式文本」。现在改用
 * `layout/keySpelling.ts` 的 `keyHasExtraText`（它先拼出规范形式 `Eb` 再与 `raw` 比），
 * 与五线谱画不画调号用的是**同一个**判断，两处不会再各说各话。
 */
function keyText(key: KeySignature | undefined, sink: (draft: RenderDiagnosticDraft) => void): string | undefined {
  if (key === undefined) {
    sink({
      code: CODES.keyAbsent,
      level: 'info',
      message: 'Score.key 缺席：不画调号标签（默认调号无证据，spec §8.7 未记载缺省行为）',
      anchor: DOCUMENT_ANCHOR,
    });
    return undefined;
  }
  if (key.tonic === undefined) {
    sink({
      code: CODES.keyUnresolved,
      level: 'warning',
      message: 'K: 未能解析出主音：原样转述 raw，不从 alter 反推主音（升降号数量到调的映射在大小调间二义）',
      anchor: DOCUMENT_ANCHOR,
    });
  } else if (keyHasExtraText(key)) {
    sink({
      code: CODES.keyModeUnrecognized,
      level: 'info',
      message: 'K: 含未识别的调式文本：mode 原文一并显示，不假设 major、不据 mode 推任何 degree',
      anchor: DOCUMENT_ANCHOR,
    });
  }
  return `K: ${key.raw}`;
}

/**
 * `fraction` → `num/den`；`raw` 分支原样显示，不换算成 4/4，并发 `meter.raw`（§3.2
 * 拍号行）。`meter` 整体缺席时不发任何诊断——Domain 对缺省拍号没有约定的事实可转述。
 */
function meterText(meter: Meter | undefined, sink: (draft: RenderDiagnosticDraft) => void): string | undefined {
  if (meter === undefined) return undefined;
  if (meter.kind === 'raw') {
    sink({
      code: CODES.meterRaw,
      level: 'info',
      message: `拍号 ${meter.raw} 是 DOC-ONLY 的 raw 形态：原样显示，不换算成 4/4`,
      anchor: DOCUMENT_ANCHOR,
    });
    return meter.raw;
  }
  return `${String(meter.num)}/${String(meter.den)}`;
}

/** `beat`+`bpm` 齐全画 `♩=N`，否则原样显示 `raw`；无 `Q:` 时整体省略（§3.2 速度行）。 */
function tempoText(tempo: Tempo | undefined): string | undefined {
  if (tempo === undefined) return undefined;
  return tempo.beat !== undefined && tempo.bpm !== undefined ? `♩=${String(tempo.bpm)}` : tempo.raw;
}

function textBlockLayout(
  block: TextBlock,
  measurer: TextMeasurer,
  sink: (draft: RenderDiagnosticDraft) => void,
): ScoreHeaderTextBlockLayout {
  if (!block.closed) {
    sink({
      code: CODES.textBlockUnclosed,
      level: 'info',
      message: '文本块未闭合（源文本缺少终止标记）：照常渲染已捕获的内容，不截断也不报错',
      anchor: DOCUMENT_ANCHOR,
      sourceRef: block.origin,
    });
  }
  return {
    lines: block.lines.map((text) => line(text, SCORE_HEADER_METRICS.textBlockFontSize, measurer)),
    closed: block.closed,
  };
}

/** `key`/`meter` fallback 诊断只对「消费它们的记谱」有意义（见下）。 */
function noopSink(): void {
  // 故意留空：见 `layoutScoreHeader` 里 `keyMeterSink` 的选择逻辑。
}

/**
 * 纯函数：同一 `(score, measurer)` 必然得到逐字段相等的 `ScoreHeaderLayout`
 * （`measurer` 按 §2.8 的契约也必须是纯函数）。`score` 不被读取以外的方式使用。
 */
export function layoutScoreHeader(score: Score, measurer: TextMeasurer): ScoreHeaderLayout {
  const drafts: RenderDiagnosticDraft[] = [];
  const collect = (draft: RenderDiagnosticDraft): void => {
    drafts.push(draft);
  };

  /**
   * `key.absent` / `key.unresolved` / `key.mode-unrecognized` / `meter.raw` 是**简谱
   * 渲染**的保守呈现判断（简谱头部标签把 `K:`/拍号画成文本，需要知道这四种情形），
   * 不是「任何一份乐谱都要报告」的通用事实——没有任何声部在消费 `K:`/`M:` 时，
   * 报出「调号不可解」没有意义（连一个会显示它的地方都没有）。因此只在
   * `score.voices` 里存在至少一个 `style === 'jianpu'` 时才发这四类诊断。
   * **T7.4 起 `staff` 也在其中**：五线谱要画调号与拍号（`layoutStaff.ts` 的
   * `staffKeySignature` / `staffTimeSignature` 直接消费 `Score.key` / `Score.meter`），
   * 所以「调号不可解」「拍号是 raw 形态」对它同样是需要报告的事实。
   */
  const hasKeyMeterConsumer = score.voices.some(
    (voice) => voice.style === 'jianpu' || voice.style === 'staff',
  );
  const keyMeterSink = hasKeyMeterConsumer ? collect : noopSink;

  const [primaryTitle, ...subtitleTexts] = score.titles;
  const key = keyText(score.key, keyMeterSink);
  const meter = meterText(score.meter, keyMeterSink);
  const tempo = tempoText(score.tempo);

  return {
    ...(primaryTitle === undefined
      ? {}
      : { title: line(primaryTitle, SCORE_HEADER_METRICS.titleFontSize, measurer) }),
    subtitles: subtitleTexts.map((text) => line(text, SCORE_HEADER_METRICS.subtitleFontSize, measurer)),
    credits: score.credits.map((text) => line(text, SCORE_HEADER_METRICS.creditFontSize, measurer)),
    notes: score.notes.map((text) => line(text, SCORE_HEADER_METRICS.noteFontSize, measurer)),
    ...(key === undefined ? {} : { key: line(key, SCORE_HEADER_METRICS.metaFontSize, measurer) }),
    ...(meter === undefined ? {} : { meter: line(meter, SCORE_HEADER_METRICS.metaFontSize, measurer) }),
    ...(tempo === undefined ? {} : { tempo: line(tempo, SCORE_HEADER_METRICS.metaFontSize, measurer) }),
    textBlocks: score.textBlocks.map((block) => textBlockLayout(block, measurer, collect)),
    diagnostics: collectRenderDiagnostics(drafts),
  };
}
