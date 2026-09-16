/**
 * notation/jianpu —— 三段**独立段落构造**：关系（tuplet 括号 / tie-slur 弧线）、歌词行、
 * 头部标签（M2 方案 v1.1.1 §3.2 / §20 / §22 / §24 / §8.7 / §8.4，T4）。
 *
 * 之所以自成一个文件：这三段都**不参与事件排布**——它们只消费「事件所在列的 x / 行谱
 * 归属」这一个已算好的结果，以及 `Score` 的 `key` / `meter` 两个头部字段。把它们与
 * `layoutJianpu.ts` 的 measure 切分 / 换行放在一起，单文件必然超过 350 行的工程上限，
 * 而按行数硬压行会把可读性换掉（/check P2-5）。
 *
 * 歌词部分在 T5.2-A 拆成**归属**（`assignLyricSyllables` / `lyricRowsBySystem`）与
 * **落点**（`buildLyricNodes`）两步：前者要在行高定案**之前**跑（行高取决于每行谱用掉
 * 几行歌词），后者要在行高定案**之后**跑（y 取自行谱原点）。`kind === 'skip'`（`*`）
 * 在归属阶段就被滤掉——它在 parse 层已消耗对齐位却不绑 `target`，照旧画出来就会被当成
 * 「无对齐目标」丢进行尾顺排，正是真实语料里星号堆成矩阵的成因。
 *
 * 依赖方向单向 `layoutJianpu.ts → jianpuSections.ts → jianpuGlyphs.ts`，无环。
 * 尺寸一律取自 `layout/metrics.ts` 的 `JIANPU_METRICS`（尺寸常量唯一来源）。
 */

import type { DomainIndex, KeySignature, LyricSyllable, Meter, VoiceId } from '../../domain';
import { JIANPU_METRICS } from '../layout/metrics';
import type { TextMeasurer } from '../layout/textMeasurer';
import { RENDER_DIAGNOSTIC_CODES as CODES } from '../model/diagnostics';
import { resolveVoiceRelations } from '../model/relations';
import type { Anchor, RenderVoice } from '../model/types';
import { draftOf, glyph } from './jianpuGlyphs';
import type {
  DraftSink,
  JianpuArc,
  JianpuLabel,
  JianpuLyricNode,
  JianpuNode,
  JianpuTupletBracket,
} from './jianpuGlyphs';

/** 弧线 / 括号的端点一律取列中心，保证两端算法一致。 */
function centerOf(node: JianpuNode): number {
  return node.x + node.width / 2;
}

export interface RelationLayout {
  readonly tuplets: readonly JianpuTupletBracket[];
  readonly arcs: readonly JianpuArc[];
}

/**
 * tuplet 只额外画方括号 + `p` 数字，**不读 `p`/`q` 去推算 effective duration**
 * （P1-C / U25：`q === 0` 的语义未验证，渲染层不去猜）；tie / slur 的 A 类恢复状态
 * （`unresolved` / `unclosed`）画**单端弧**，不为缺失的对端造端点。
 */
export function relationLayout(
  voice: RenderVoice,
  index: DomainIndex,
  nodeByEvent: ReadonlyMap<string, JianpuNode>,
  sink: DraftSink,
): RelationLayout {
  const tuplets: JianpuTupletBracket[] = [];
  const arcs: JianpuArc[] = [];

  for (const resolved of resolveVoiceRelations(voice.voice, index)) {
    const relation = resolved.relation;
    const anchor: Anchor = {
      kind: 'relation',
      voiceId: voice.voiceId,
      relationId: resolved.relationId,
    };
    const nodes = resolved.resolved
      .map((endpoint) => nodeByEvent.get(endpoint.event.id))
      .filter((node): node is JianpuNode => node !== undefined);
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (first === undefined || last === undefined) continue;

    if (relation.kind === 'tuplet') {
      const ratioUnverified = relation.q === undefined || relation.q === 0;
      tuplets.push({
        anchor,
        label: String(relation.p),
        x1: first.x,
        x2: last.x + last.width,
        y: first.y + JIANPU_METRICS.tupletBracketOffsetY,
        hookHeight: JIANPU_METRICS.tupletBracketHookHeight,
        complete: relation.status === 'complete' && !ratioUnverified,
      });
      if (ratioUnverified) {
        sink(
          draftOf(
            CODES.tupletRatioUnverified,
            'info',
            `连音记号 ${relation.raw} 的 q 缺失或为 0（spec Appendix A U25）：只画括号 + p 数字，成员按字面 duration 排布，不做任何时值缩放`,
            anchor,
          ),
        );
      }
      if (relation.status === 'incomplete') {
        sink(
          draftOf(
            CODES.tupletIncomplete,
            'info',
            `连音记号 ${relation.raw} 的成员不完整：括号按已有成员范围画，缺失端不补`,
            anchor,
          ),
        );
      }
      continue;
    }
    if (relation.kind !== 'tie' && relation.kind !== 'slur') continue;

    const open =
      relation.kind === 'tie' ? relation.status !== 'resolved' : relation.status !== 'closed';
    arcs.push({
      anchor,
      kind: relation.kind,
      x1: centerOf(first),
      x2: open ? centerOf(first) + JIANPU_METRICS.arcOpenLength : centerOf(last),
      y: first.y + JIANPU_METRICS.arcOffsetY,
      height: JIANPU_METRICS.arcHeight,
      open,
    });
    if (open) {
      sink(
        draftOf(
          relation.kind === 'tie' ? CODES.tieUnresolved : CODES.slurUnclosed,
          'info',
          `${relation.kind} 在源文本里未闭合（parse 层如实记录的恢复状态）：只画单端弧，不为缺失的对端造端点`,
          anchor,
        ),
      );
    }
  }

  return { tuplets, arcs };
}

/** 歌词里的 `-` / `_` / `|` 在 Domain 里是普通字符（U31/U32）：原样输出，不做语义。 */
const LYRIC_LITERAL_MARKERS = ['-', '_', '|'];

/** 事件在布局产物里的落点：列左边界 + 它被换行分到了第几行谱。 */
export interface LyricColumn {
  readonly x: number;
  readonly systemIndex: number;
}

/**
 * 一个**可见**歌词音节已经定下来的归属：落在第几行谱、属于第几段（verse）、
 * 有没有对齐到某一列。`alignedX` 缺失即「没有可对齐目标」。
 */
export interface LyricAssignment {
  readonly syllable: LyricSyllable;
  readonly verseIndex: number;
  readonly systemIndex: number;
  readonly alignedX: number | undefined;
}

/**
 * 把 `voice.voice.lyricLines` 归属到各行谱（T5.2-A）。返回值按 `lyricLines` 的文档顺序
 * 分组，**每组对应一条 `w:` 行**——分组边界是后续「行尾顺排」游标的作用域。
 *
 * 两条硬规则：
 *
 * 1. **`kind === 'skip'`（`*`）不产生任何可见音节**。它在 parse 层已经**消耗掉了一个
 *    可唱事件位**（`lyrics.ts` 用 `singable[index]` 取位后只是不绑 `target`），所以这里
 *    直接跳过既不影响其后音节的对齐，也不会把一串没有 `target` 的 `*` 塞进「行尾顺排」
 *    队列——真实语料里那正是 375 个星号堆成矩阵的成因。`merge` 按 Domain 给的事实当作
 *    可见音节照常处理，不猜额外的视觉语义。
 * 2. **跨行谱跟随音符**：音节落在哪一行谱由它 `target` 所在列决定，而不是由 `w:` 行的
 *    序号决定。没有 `target` 的可见音节（音节数多于可唱事件时会出现）按**三级**兜底：
 *    1) 有 `target` → 该事件所在行谱；
 *    2) 无 `target` → 本行内**最后一个已对齐音节**所在的行谱；
 *    3) 整行一个都没对齐上 → 用 `LyricLine.bodyRange` 解析：`lastEventId` 优先、
 *       退而取 `firstEventId`。`bodyRange` 记的是这条 `w:` 绑定的正文**产生的全部事件**
 *       （含 rest / barline 等不可唱事件），它们照样有布局节点，所以即便一个可唱事件都
 *       没有（整行是休止），歌词也能落到**正确的那一行谱**，而不是被打回第 0 行谱。
 *    `bodyRange` 为 `null`（该 `w:` 没有绑定目标）或解析不到列时才退到第 0 行谱——那是
 *    「确实无从得知」的保守兜底，`buildLyricNodes` 会照常发 target-missing 诊断。
 */
export function assignLyricSyllables(
  voice: RenderVoice,
  columnOf: (eventId: string) => LyricColumn | undefined,
): readonly (readonly LyricAssignment[])[] {
  const systemOfEvent = (eventId: string | undefined): number | undefined =>
    eventId === undefined ? undefined : columnOf(eventId)?.systemIndex;

  return voice.voice.lyricLines.map((line) => {
    const assignments: LyricAssignment[] = [];
    // 第三级兜底：整行都对不齐时，至少把它放到这条 `w:` 所覆盖的那一段正文所在的行谱。
    let currentSystem =
      systemOfEvent(line.bodyRange?.lastEventId) ??
      systemOfEvent(line.bodyRange?.firstEventId) ??
      0;

    for (const syllable of line.syllables) {
      if (syllable.kind === 'skip') continue;
      const column = syllable.target === undefined ? undefined : columnOf(syllable.target.eventId);
      if (column !== undefined) currentSystem = column.systemIndex;
      assignments.push({
        syllable,
        verseIndex: line.verseIndex,
        systemIndex: column?.systemIndex ?? currentSystem,
        alignedX: column?.x,
      });
    }

    return assignments;
  });
}

/**
 * 每一行谱实际用掉几行歌词 = 该行谱内出现过的最大 `verseIndex + 1`（没有歌词则为 0）。
 * `layoutJianpu` 拿它给每行谱补高度，下一行谱才不会压到上一行的歌词上。
 */
export function lyricRowsBySystem(
  lines: readonly (readonly LyricAssignment[])[],
  systemCount: number,
): readonly number[] {
  const rows = new Array<number>(Math.max(0, systemCount)).fill(0);
  for (const line of lines) {
    for (const assignment of line) {
      const current = rows[assignment.systemIndex];
      if (current === undefined) continue;
      rows[assignment.systemIndex] = Math.max(current, assignment.verseIndex + 1);
    }
  }
  return rows;
}

/**
 * 歌词节点：按 `LyricSyllable.target`（`NoteRef`）对齐到该事件的**列 x**，纵向则落在
 * **所在行谱自己的**歌词基线上，同段（`verseIndex`）同行谱 y 相同、不同段相差一个
 * `lyricLineGap`（§24）。`kind` 按 Domain 给的类别原样携带，**不在渲染层重新解释**。
 *
 * **没有可对齐目标的音节**按方案 §3.2「按顺序落在行尾」处理，游标按
 * **(行谱, `verseIndex`)** 维护——**不是**按 `w:` 行。这两者不等价：`verseIndex` 在
 * parse 层是按绑定的正文行重置的，所以分属不同正文行的多条 `w:` 通常**都是 verse 0**，
 * 它们落进同一行谱时共享的是**同一条歌词基线**；若各自从头维护游标，两组溢出音节就会
 * 在这条基线上撞在一起。游标从该 (行谱, verse) 上**最后一个已放置音节的右侧**（还没有
 * 已放置音节时从行起点 0）起，用注入的 `TextMeasurer` 量出宽度后依次推进，因此同一条
 * 基线上 x 单调递增、互不重叠，也不会把后面几行谱的音节倒灌到第一行谱去。
 * 它**不会被钉在 x = 0**——把一串无目标音节全堆在原点，视觉上等同于「丢了」。
 * `aligned: false` 如实标出，并发一条诊断（每声部首次）。
 */
export function buildLyricNodes(
  lines: readonly (readonly LyricAssignment[])[],
  voiceId: VoiceId,
  baselineOf: (systemIndex: number, verseIndex: number) => number,
  measurer: TextMeasurer,
  sink: DraftSink,
): readonly JianpuLyricNode[] {
  const lyrics: JianpuLyricNode[] = [];
  const anchor: Anchor = { kind: 'voice', voiceId };
  const size = JIANPU_METRICS.lyricFontSize;
  let markerReported = false;
  let missingReported = false;

  // 每条歌词基线（行谱 × verse）一个游标：指向「下一个无目标音节可以落脚的最左位置」。
  // 跨 `w:` 行共享——同一 (行谱, verse) 就是同一条基线，游标必须接着上一条行走。
  const tailX = new Map<string, number>();

  for (const line of lines) {
    for (const assignment of line) {
      const { syllable, systemIndex, verseIndex, alignedX } = assignment;
      const row = `${String(systemIndex)}/${String(verseIndex)}`;
      const width = measurer.measure(syllable.text, { fontSize: size }).width;
      const x = alignedX ?? tailX.get(row) ?? 0;
      tailX.set(row, x + width + JIANPU_METRICS.lyricSyllableGap);

      if (alignedX === undefined && !missingReported) {
        missingReported = true;
        sink(
          draftOf(
            CODES.lyricTargetMissing,
            'info',
            '本声部存在没有可对齐目标的歌词音节：不为它伪造列位置，按顺序落在所在行谱的行尾',
            anchor,
            syllable.origin,
          ),
        );
      }
      if (!markerReported && LYRIC_LITERAL_MARKERS.some((mark) => syllable.text.includes(mark))) {
        markerReported = true;
        sink(
          draftOf(
            CODES.lyricMarkerLiteral,
            'info',
            '歌词中的 - / _ / | 是普通字符（spec Appendix A U31/U32）：原样输出，不做连字符或延长线语义',
            anchor,
            syllable.origin,
          ),
        );
      }

      lyrics.push({
        anchor,
        verseIndex,
        systemIndex,
        syllableKind: syllable.kind,
        text: glyph(syllable.text, x, baselineOf(systemIndex, verseIndex), size),
        aligned: alignedX !== undefined,
      });
    }
  }

  return lyrics;
}

/**
 * 头部标签：`K: <值>` 与拍号。**没有任何分支输出 `1=<tonic>`**（P1-2）。
 *
 * `KeySignature` 四形态 fallback 逐条对应 §3.2 的表——**但诊断不在这里发**（T5 修订）：
 * `key.absent` / `key.unresolved` / `key.mode-unrecognized` / `meter.raw` 现在只由
 * `notation/layout/scoreHeader.ts` 在文档级发一次。原因：`Score.key`/`Score.meter`
 * 是文档级事实，一份乐谱可以有多个 `style=jianpu` 声部，每个声部各自调用一次本函数
 * 若各自都发一遍，同一件事就会被报告 N 次（且两处各自独立走
 * `collectRenderDiagnostics` 时序号都从 0 起算，`(document, code)` 组合会撞出重复
 * id）。本函数因此**只负责画标签文本**，不产生任何 `RenderDiagnosticDraft`——
 * `sink` 参数保留只是为了与同文件其它段落（`relationLayout` / `buildLyricNodes`）
 * 签名一致，当前不会被调用。
 */
export function buildHeaderLabels(
  key: KeySignature | undefined,
  meter: Meter | undefined,
  measurer: TextMeasurer,
  _sink: DraftSink,
): readonly JianpuLabel[] {
  const labels: JianpuLabel[] = [];
  const anchor: Anchor = { kind: 'document' };
  const size = JIANPU_METRICS.labelFontSize;
  let x = 0;

  if (key !== undefined) {
    const text = `K: ${key.raw}`;
    labels.push({ anchor, kind: 'key', text: glyph(text, x, size, size) });
    x += measurer.measure(text, { fontSize: size }).width + JIANPU_METRICS.headerLabelGap;
  }

  if (meter !== undefined) {
    const text = meter.kind === 'fraction' ? `${String(meter.num)}/${String(meter.den)}` : meter.raw;
    labels.push({ anchor, kind: 'meter', text: glyph(text, x, size, size) });
  }

  return labels;
}
