/**
 * notation/jianpu —— 三段**独立段落构造**：关系（tuplet 括号 / tie-slur 弧线）、歌词行、
 * 头部标签（M2 方案 v1.1.1 §3.2 / §20 / §22 / §24 / §8.7 / §8.4，T4）。
 *
 * 之所以自成一个文件：这三段都**不参与事件排布**——它们只消费「事件所在列的 x/宽度」
 * 这一个已算好的结果，以及 `Score` 的 `key` / `meter` 两个头部字段。把它们与
 * `layoutJianpu.ts` 的 measure 切分 / 换行 / 事件节点建构放在一起，单文件必然超过
 * 350 行的工程上限，而按行数硬压行会把可读性换掉（/check P2-5）。
 *
 * 依赖方向单向 `layoutJianpu.ts → jianpuSections.ts → jianpuGlyphs.ts`，无环。
 * 尺寸一律取自 `layout/metrics.ts` 的 `JIANPU_METRICS`（尺寸常量唯一来源）。
 */

import type { DomainIndex, KeySignature, Meter } from '../../domain';
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

/**
 * 歌词行：按 `LyricSyllable.target`（`NoteRef`）对齐到该事件的**列 x**，多段按
 * `lyricLines` 的文档顺序逐行下排（§24）；`kind`（`text` / `skip` / `merge`）按 Domain
 * 给的类别原样携带，**不在渲染层重新解释**。
 *
 * **没有可对齐目标的音节**（`target` 缺失，或该事件不在本声部的布局产物里）按方案 §3.2
 * 「按顺序落在行尾」处理：从该行**最后一个已放置音节的右侧**（行首则从行起点 0）起，
 * 用注入的 `TextMeasurer` 量出宽度后依次推进，因此同一行内 x 单调递增、互不重叠。
 * 它**不会被钉在 x = 0**——把一串无目标音节全堆在原点，视觉上等同于「丢了」。
 * `aligned: false` 如实标出，并发一条诊断（每声部首次）。
 *
 * `nodeX` 是「事件 id → 列左边界」的查询，由 `layoutJianpu` 的位置索引提供。
 */
export function buildLyricNodes(
  voice: RenderVoice,
  nodeX: (eventId: string) => number | undefined,
  baselineOfRow: (row: number) => number,
  measurer: TextMeasurer,
  sink: DraftSink,
): readonly JianpuLyricNode[] {
  const lyrics: JianpuLyricNode[] = [];
  const anchor: Anchor = { kind: 'voice', voiceId: voice.voiceId };
  const size = JIANPU_METRICS.lyricFontSize;
  let markerReported = false;
  let missingReported = false;

  for (const [row, line] of voice.voice.lyricLines.entries()) {
    // 行内游标：始终指向「下一个无目标音节可以落脚的最左位置」。
    let tailX = 0;

    for (const syllable of line.syllables) {
      const alignedX = syllable.target === undefined ? undefined : nodeX(syllable.target.eventId);
      const width = measurer.measure(syllable.text, { fontSize: size }).width;
      const x = alignedX ?? tailX;
      tailX = x + width + JIANPU_METRICS.lyricSyllableGap;

      if (alignedX === undefined && !missingReported) {
        missingReported = true;
        sink(
          draftOf(
            CODES.lyricTargetMissing,
            'info',
            '本声部存在没有可对齐目标的歌词音节：不为它伪造列位置，按顺序落在行尾',
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
        verseIndex: line.verseIndex,
        syllableKind: syllable.kind,
        text: glyph(syllable.text, x, baselineOfRow(row), size),
        aligned: alignedX !== undefined,
      });
    }
  }

  return lyrics;
}

/**
 * 头部标签：`K: <值>` 与拍号。**没有任何分支输出 `1=<tonic>`**（P1-2）。
 *
 * `KeySignature` 四形态 fallback 逐条对应 §3.2 的表：
 * - `tonic` 有值且 `raw` 就是它 → 画 `K: <值>`，无诊断；
 * - `tonic` 有值但 `raw` 还带调式文本 → mode 原文一并显示 + `key.mode-unrecognized`
 *   （**不假设 major、不据 mode 推任何 degree**）；
 * - `tonic` 缺失 → 原样转述 `K: <raw>` + `key.unresolved`（**不从 `alter` 反推主音**：
 *   升降号数量到调的映射在大小调间二义）；
 * - `key` 整个缺席 → **不画调号标签** + `key.absent`（默认调号无证据，spec §8.7）。
 */
export function buildHeaderLabels(
  key: KeySignature | undefined,
  meter: Meter | undefined,
  measurer: TextMeasurer,
  sink: DraftSink,
): readonly JianpuLabel[] {
  const labels: JianpuLabel[] = [];
  const anchor: Anchor = { kind: 'document' };
  const size = JIANPU_METRICS.labelFontSize;
  let x = 0;

  if (key === undefined) {
    sink(
      draftOf(
        CODES.keyAbsent,
        'info',
        'Score.key 缺席：不画调号标签（默认调号无证据，spec §8.7 未记载缺省行为）',
        anchor,
      ),
    );
  } else {
    const text = `K: ${key.raw}`;
    labels.push({ anchor, kind: 'key', text: glyph(text, x, size, size) });
    x += measurer.measure(text, { fontSize: size }).width + JIANPU_METRICS.headerLabelGap;
    if (key.tonic === undefined) {
      sink(
        draftOf(
          CODES.keyUnresolved,
          'warning',
          'K: 未能解析出主音：原样转述 raw，不从 alter 反推主音（升降号数量到调的映射在大小调间二义）',
          anchor,
        ),
      );
    } else if (key.raw.trim() !== key.tonic) {
      sink(
        draftOf(
          CODES.keyModeUnrecognized,
          'info',
          'K: 含未识别的调式文本：mode 原文一并显示，不假设 major、不据 mode 推任何 degree',
          anchor,
        ),
      );
    }
  }

  if (meter !== undefined) {
    const text = meter.kind === 'fraction' ? `${String(meter.num)}/${String(meter.den)}` : meter.raw;
    labels.push({ anchor, kind: 'meter', text: glyph(text, x, size, size) });
    if (meter.kind === 'raw') {
      sink(
        draftOf(
          CODES.meterRaw,
          'info',
          `拍号 ${meter.raw} 是 DOC-ONLY 的 raw 形态：原样显示，不换算成 4/4`,
          anchor,
        ),
      );
    }
  }

  return labels;
}
