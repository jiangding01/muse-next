/**
 * canonical 序列化 —— 歌词 `w:` 行回写（M1.7 T5，方案 v1.1 §3 决策 2 / §7 T5）。
 *
 * 本文件只管两件事：
 * 1. 把一条 `LyricLine` 渲染成 `w: ` + 音节文本（`renderLyricLine`）；
 * 2. 把一个声部的 `LyricLine[]` 按 `bodyRange` 分组／排序，交给 `index.ts` 在
 *    正确的位置插入——**放哪一行**由 `body.ts` 已经算好的
 *    `CanonicalBodyLine.range` / `lyricRangeEnd` 决定，本文件不重新推导行边界。
 *
 * ## 音节分隔（parse `parse/body/lyrics.ts` `scanAtoms`/`foldSyllables` 的逆运算）
 *
 * `LyricSyllable.text` 已经是原文切片（`~`、`*` 都在 text 内，决策 5），唯一
 * 丢失的事实是「两个音节之间原文有没有空白」。parse 层只在**遇到空白**时才断开
 * atom（`scanAtoms`），所以这条事实可以从 `offsetInLine` 精确复原：
 * `syllables[i+1].offsetInLine === syllables[i].offsetInLine + syllables[i].text.length`
 * 意味着原文里两个音节紧邻（中间无空白，例如连写的汉字，或 `a~b` 之后紧跟 `c`），
 * 不写分隔符；否则原文里一定有至少一个空白（决策 D：canonical 规范化空白，
 * 写回单个空格即可，不追究原文是几个空白）。
 *
 * 这条规则对全部三种 `kind`（`text`/`skip`/`merge`）统一有效，因为三者的 `text`
 * 都已包含各自在原文里的完整字符（`skip` 是 `*` 本身，`merge` 是含 `~` 的整条链），
 * `offsetInLine` 与 `text.length` 对任何 kind 都精确描述了它在原文里的起止位置——
 * 因此本模块不需要对 `kind` 做任何分支，也不存在「某类音节无法可靠回写」的情形；
 * 唯一无法回写的是「行本身放不到一个能保证重解析语义不变的位置」（见下）。
 */

import type { LyricBodyRange, LyricLine, Voice } from '../../../../domain';
import { canonicalWarning } from './diagnostic';
import type { CanonicalDiagnostic } from './voice';

/**
 * `LyricBodyRange` → 分组 key。必须与 `body.ts`（`collectRanges`）用同一规则：
 * 两处的 `LyricBodyRange` 值都直接取自同一批 `Voice.lyricLines[].bodyRange`
 * 对象（`body.ts` 的 `rangeEndAt` 存的就是原对象，未重建），所以字符串拼接
 * 结果必然一致，不需要共享一份实现。
 */
export function lyricRangeKey(range: LyricBodyRange): string {
  return `${range.firstEventId}#${range.lastEventId}`;
}

/** 单条 `LyricLine` 的音节文本（不含 `w: ` 前缀），见文件头的分隔规则。 */
function renderSyllableText(line: LyricLine): string {
  let text = '';
  let expectedNext: number | null = null;
  for (const syllable of line.syllables) {
    if (expectedNext !== null && syllable.offsetInLine !== expectedNext) {
      text += ' ';
    }
    text += syllable.text;
    expectedNext = syllable.offsetInLine + syllable.text.length;
  }
  return text;
}

/** 渲染一条 `w:` 行的完整文本。 */
export function renderLyricLine(line: LyricLine): string {
  return `w: ${renderSyllableText(line)}`;
}

/**
 * 把一个声部里 `bodyRange !== null` 的 `LyricLine` 按 range 分组，组内按
 * `verseIndex` 升序排列（多段歌词按出现顺序写回，spec §24.2 点 4）。
 * `index.ts` 用这份分组在 `CanonicalBodyLine.lyricRangeEnd` 命中的行之后
 * 依次插入。
 */
export function groupBoundLyricLines(voice: Voice): ReadonlyMap<string, readonly LyricLine[]> {
  const map = new Map<string, LyricLine[]>();
  for (const line of voice.lyricLines) {
    const range = line.bodyRange;
    if (range === null) {
      continue;
    }
    const key = lyricRangeKey(range);
    const bucket = map.get(key);
    if (bucket === undefined) {
      map.set(key, [line]);
    } else {
      bucket.push(line);
    }
  }
  for (const bucket of map.values()) {
    bucket.sort((a, b) => a.verseIndex - b.verseIndex);
  }
  return map;
}

export interface LeadingLyricLines {
  readonly lines: readonly string[];
  readonly diagnostics: readonly CanonicalDiagnostic[];
}

/**
 * 无绑定目标（`bodyRange === null`）的 `LyricLine`：只有当它是**整份文档正文区
 * 的第一处内容**时，写在 `[V:n]` 之后、首个事件行之前才能保证重解析仍得到
 * `bodyRange === null`——parse 层的 `lastLyricTarget`（`parse/body/segments.ts`）
 * 是横跨全部声部的文档级状态，只有在它从未被设置过（即这一段之前，任何声部都
 * 还没有产生过 bodyLine / inline trailing）时，`target` 才会解析成 `undefined`。
 *
 * `canPlace` 由调用方（`index.ts`）判定：`false` 覆盖两种情形——(a) 本声部压根
 * 没有事件行可以挂靠（`renderVoiceBody` 对零事件声部连 `[V:n]` 都不写）；
 * (b) 本声部之前已经有别的正文内容（本声部或更早的声部），插进去会被重解析
 * 绑定到那条更早的内容上，而不是保持 `bodyRange === null`。两种情形都不写，
 * 只发 warning，不产出一个「看起来对但语义会漂移」的行（拍板 F）。
 */
export function renderLeadingLyricLines(voice: Voice, canPlace: boolean): LeadingLyricLines {
  const unbound = voice.lyricLines
    .filter((line): line is LyricLine & { readonly bodyRange: null } => line.bodyRange === null)
    .slice()
    .sort((a, b) => a.verseIndex - b.verseIndex);

  if (unbound.length === 0) {
    return { lines: [], diagnostics: [] };
  }

  if (!canPlace) {
    const diagnostics = unbound.map((line) =>
      canonicalWarning(
        'jcx.serialize.lyric-line-unplaceable',
        `声部 ${voice.id} 的第 ${line.verseIndex} 段歌词没有绑定目标（bodyRange 为 null），` +
          `但当前位置无法安全放置它（不是整份文档正文区的第一处内容，或该声部没有` +
          `任何事件行可挂靠）——写在这里会被重解析绑定到错误的目标或产生一个不存在的` +
          `声部，因此该 w: 行未写入 canonical 文本`,
        line.syllables[0]?.origin,
      ),
    );
    return { lines: [], diagnostics };
  }

  return { lines: unbound.map(renderLyricLine), diagnostics: [] };
}

/**
 * `groupBoundLyricLines` 里没有被任何一条 `CanonicalBodyLine.lyricRangeEnd`
 * 消费到的分组（2026-09-15 用户裁决②，`/check` P2）。
 *
 * `body.ts` 的 `collectRanges` 按 `lastEventId` 对应的下标去重登记 `endAt`
 * （`if (!endAt.has(end)) endAt.set(end, range)`）：两条 `bodyRange` 不同
 * （`firstEventId` 不同）但共享同一个 `lastEventId` 时，只有先遇到的那条会
 * 被记录、后一条会被「影子遮住」——它既不会成为强制断行点、也不会被任何行
 * 的 `lyricRangeEnd` 命中，它对应的 `w:` 行因此无处插入。这不是「没有绑定
 * 目标」（`bodyRange` 本身不是 `null`），根因不同，所以用独立的
 * `jcx.serialize.lyric-range-shadowed`，不复用 `lyric-line-unplaceable`。
 *
 * `index.ts` 在组装完一个声部的全部 body 行之后调用本函数：`consumedKeys`
 * 是该声部里所有真正被某一行 `lyricRangeEnd` 命中过的 key，`boundLyrics` 是
 * `groupBoundLyricLines` 的全量分组，两者之差就是被遮住、从未写出的 `w:` 行。
 */
export function collectShadowedLyricLines(
  voice: Voice,
  boundLyrics: ReadonlyMap<string, readonly LyricLine[]>,
  consumedKeys: ReadonlySet<string>,
): readonly CanonicalDiagnostic[] {
  const diagnostics: CanonicalDiagnostic[] = [];
  for (const [key, group] of boundLyrics) {
    if (consumedKeys.has(key)) {
      continue;
    }
    for (const line of group) {
      diagnostics.push(
        canonicalWarning(
          'jcx.serialize.lyric-range-shadowed',
          `声部 ${voice.id} 的第 ${line.verseIndex} 段歌词绑定的正文区间` +
            `（${key}）与另一段歌词共享同一个收尾事件，行边界规划只保留了先出现的` +
            `那一段，这条 w: 行没有可插入的位置，因此未写入 canonical 文本`,
          line.syllables[0]?.origin,
        ),
      );
    }
  }
  return diagnostics;
}
