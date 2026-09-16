/**
 * parser-reachable 边界 fixture 的形态 pin + 三条已知限制的精确 pin
 * （M1.8 T2(a)/(4)，方案 v1.1 §4 T2 / §6 第 7、11 条）。
 *
 * ## 分工
 *
 * `roundtrip.test.ts` / `roundtrip.closure.test.ts` 已经对
 * `tests/fixtures/jcx/**\/*.jcx` 全体跑四级矩阵 + 闭包矩阵，新 fixture 放进目录
 * 就自动被纳入——那是「不许退化」。本文件补的是另一半：**具体退化成什么样会被
 * 看见**。矩阵只回答「往返一致」，它对「一致地丢掉同一段内容」是盲的（两侧都没有
 * 的东西，投影当然相等）。下面的用例把每个边界 fixture 的 canonical 形态与事件分类
 * 钉成字面值，内容被吞掉时是这些用例先失败，而不是等到有人肉眼发现。
 *
 * serializer-only 的 defensive branch（三个零覆盖 code）与 11 个
 * `jcx.serialize.*` code 的覆盖表在 `canonical.boundary.domain.test.ts`。
 *
 * ## UNVERIFIED 语义的表达方式
 *
 * 标题里写「pinned current behaviour, not a spec claim」的用例，钉的是**当前实现
 * 恰好产出什么**，不是「JCX 就该这样」。切音符号、悬空 strokePrefix、组级时值后缀
 * `[CEG]2`、裸 duration 叶子 `|||2` 在 spec 里都没有条目（Appendix A U26 家族），
 * 方案 §6 第 2 条禁止把它们的语义写进 Domain 或序列化行为。因此这些用例只断言
 * 「`UnknownEvent` 的 raw 原样保留 + 当前输出形态」，一旦将来有了 spec 级证据并
 * 决定改变行为，失败的会是这些 pin——那正是它们存在的意义。
 *
 * ## 未入库的候选（探针跑过、故意不放进 fixtures 目录）
 *
 * 方案 §6 第 3 条：L2 豁免名单只能有 `unclosed-chord.jcx`，不得扩大。下面三个候选
 * 在探针里确实通不过 L2，按硬规则留在 scratchpad 上报，不入库、不放宽、不加豁免：
 *
 * 1. 未闭合 `{` 后面跟小节线（`C2 {ab c2 | d2 e2 |`）——限制① 的新实例：`|` 落在
 *    非法词法上下文里成为 `UnknownEvent(tokenKind:'barline')`，canonical 原样写回
 *    后重解析成正常 `barline`，L2 差异 `$.voices[0].events[2].tokenKind`。本文件
 *    入库的 `grace-unclosed.jcx` 是它去掉尾随小节线后的版本，四级全绿。
 * 2. 未闭合 TAB `[` 后面跟小节线——同上，同一条差异路径。入库版本
 *    `tab-group-unclosed.jcx` 同样去掉了尾随小节线。
 * 3. 零事件声部上挂 `w:` 行（`V:1 / V:2 / [V:1] / w: la li / [V:2]CDEF|`）——
 *    canonical 发 `jcx.serialize.lyric-line-unplaceable` 并整条丢弃该歌词行，
 *    L2 差异 `$.voices[0].lyricLines.length`。这是已有的、带 warning 的显式行为
 *    （`canonical.lyrics.test.ts` 已有直测），但它让投影不相等，不能做矩阵 fixture。
 */

import { describe, expect, it } from 'vitest';

import { loadJcx } from '../../../../src/formats/jcx';
import { serializeJcx } from '../../../../src/formats/jcx/serialize';
import { fixtureBytes, fixtureNames } from './roundtrip.helpers';

/** fixture 的 canonical 正文（去掉固定的 6 行描述头，只留 `V:` 起的部分）。 */
function canonicalTail(name: string): readonly string[] {
  const { score } = loadJcx(fixtureBytes(name));
  const text = serializeJcx(score, { mode: 'canonical' }).text;
  expect(text.endsWith('\n')).toBe(true);
  return text.slice(0, -1).split('\n').slice(6);
}

/** 单声部 fixture 的事件画像：`kind` + `UnknownEvent` 的 `tokenKind` / `raw`。 */
function eventProfile(name: string, voiceIndex = 0): readonly string[] {
  const { score } = loadJcx(fixtureBytes(name));
  const voice = score.voices[voiceIndex];
  expect(voice).toBeDefined();
  if (voice === undefined) {
    return [];
  }
  return voice.events.map((event) =>
    event.kind === 'unknown' ? `unknown(${event.tokenKind}):${event.raw}` : event.kind,
  );
}

it('本文件点名的边界 fixture 都真实存在（改名后这些 pin 不得变成哑弹）', () => {
  const named = [
    'grace-unclosed.jcx',
    'stray-closers.jcx',
    'tab-group-unclosed.jcx',
    'crlf-no-trailing-newline.jcx',
    'voice-attr-quoted-space.jcx',
    'voice-empty.jcx',
    'bare-duration-leaf.jcx',
    'tab-stroke-prefix.jcx',
    'encoding/bom-crlf.jcx',
    'unclosed-chord.jcx',
    'chord-duration.jcx',
  ];
  for (const name of named) {
    expect(fixtureNames).toContain(name);
  }
});

describe('边界 fixture —— 畸形括号族', () => {
  it('grace-unclosed.jcx：未闭合 `{` 吞掉本行余下事件，canonical 补写 `}` 收口', () => {
    // 源文本正文两行：`C2 {ab c2` / `d2 e2`。`{` 之后的内容被 grace 吸收到行末，
    // 下一行不受影响——所以事件是 note / grace / note / note，没有 UnknownEvent。
    expect(eventProfile('grace-unclosed.jcx')).toEqual(['note', 'grace', 'note', 'note']);
    // canonical 把这个 grace 写成闭合形态 `{abc2}`：`}` 是渲染 grace 的语法要求，
    // 不是猜语义——重解析回来仍是同一个 grace 事件（矩阵的 L2 已经保证）。
    expect(canonicalTail('grace-unclosed.jcx')).toEqual(['V:1', '[V:1]', 'C2 {abc2} d2 e2']);
  });

  it('stray-closers.jcx：多余 `]` / `}` 落成 UnknownEvent 且 raw 原样，空 `{}` 是合法 grace', () => {
    expect(eventProfile('stray-closers.jcx')).toEqual([
      'note',
      'unknown(chordClose):]',
      'note',
      'unknown(graceClose):}',
      'barline',
      'grace',
      'note',
      'note',
      'barline',
    ]);
    // 不猜 escape、不丢字符：两个孤立收尾符号原样出现在输出里（§6 第 7 条）。
    expect(canonicalTail('stray-closers.jcx')).toEqual([
      'V:1',
      '[V:1]',
      'C2 ] D2 } |',
      '{} E2 F2 |',
    ]);
  });

  it('tab-group-unclosed.jcx：未闭合 TAB `[` 吞掉本行余下事件，canonical 补写 `]` 收口', () => {
    expect(eventProfile('tab-group-unclosed.jcx')).toEqual(['tabNote', 'tabGroup']);
    expect(canonicalTail('tab-group-unclosed.jcx')).toEqual([
      'V:1 style=tab clef=standardtab',
      '[V:1]',
      'ax/ [bx/cx/dx/]',
    ]);
  });
});

describe('边界 fixture —— 编码 × 行终止符组合', () => {
  it('crlf-no-trailing-newline.jcx：CRLF 且无末尾换行，preserve 逐字节保留、canonical 恒 LF + 末尾换行', () => {
    const original = fixtureBytes('crlf-no-trailing-newline.jcx');
    // 前提核对：这个 fixture 真的是 CRLF 且真的没有末尾换行（否则本用例是哑弹）。
    const text = new TextDecoder().decode(original);
    expect(text).toContain('\r\n');
    expect(text.endsWith('\n')).toBe(false);

    const preserved = serializeJcx(loadJcx(original), { mode: 'preserve' });
    expect(Array.from(preserved.bytes)).toEqual(Array.from(original));

    const canonical = serializeJcx(loadJcx(original).score, { mode: 'canonical' });
    expect(canonical.text).not.toContain('\r');
    expect(canonical.text.endsWith('\n')).toBe(true);
    expect(canonicalTail('crlf-no-trailing-newline.jcx')).toEqual([
      'V:1',
      '[V:1]',
      'C D E F |',
      'G A B c |',
    ]);
  });

  it('encoding/bom-crlf.jcx：BOM + CRLF，preserve 保留 BOM 与 CRLF、canonical 两者都去掉', () => {
    const original = fixtureBytes('encoding/bom-crlf.jcx');
    expect(Array.from(original.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);

    const preserved = serializeJcx(loadJcx(original), { mode: 'preserve' });
    expect(Array.from(preserved.bytes)).toEqual(Array.from(original));

    const canonical = serializeJcx(loadJcx(original).score, { mode: 'canonical' });
    expect(Array.from(canonical.bytes.slice(0, 3))).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(canonical.text).not.toContain('\r');
    expect(canonical.encoding).toBe('utf-8');
  });
});

describe('边界 fixture —— 声部属性与空声部', () => {
  it('voice-attr-quoted-space.jcx：属性值含空白照常加引号；含 `"` 的值把后续切成 unknownAttributes（pinned current behaviour, not a spec claim）', () => {
    const { score } = loadJcx(fixtureBytes('voice-attr-quoted-space.jcx'));
    const voice = score.voices[0];
    expect(voice).toBeDefined();
    // 源文本 `V:1 name="pin yin" alt="q"r"`：`name` 的值含空白但不含 `"`，正常成对；
    // `alt="q"r"` 里多出来的 `"` 没有转义机制（§6 第 7 条：不猜 escape），当前实现
    // 把它切成 `alt=q` 与一个键为 `r"` 的空值属性，两者都进 unknownAttributes 原样保留。
    expect(voice?.name).toBe('pin yin');
    expect(voice?.unknownAttributes).toEqual([
      { key: 'r"', value: '' },
      { key: 'alt', value: 'q' },
    ]);
    // canonical 原样写回这三项（含空白的值加引号，不含空白的不加），往返稳定。
    expect(canonicalTail('voice-attr-quoted-space.jcx')).toEqual([
      'V:1 name="pin yin" r"= alt=q',
      '[V:1]',
      'C D E F |',
    ]);
  });

  it('voice-empty.jcx：声明了但零事件的声部保留 `V:2` 声明行、不写空的 `[V:2]` body', () => {
    const { score } = loadJcx(fixtureBytes('voice-empty.jcx'));
    expect(score.voices).toHaveLength(2);
    expect(score.voices[0]?.events).toHaveLength(0);
    // 「空 body」不是事实，不写；但声部声明本身是事实，必须留下。
    expect(canonicalTail('voice-empty.jcx')).toEqual([
      'V:1',
      'V:2',
      '[V:2]',
      'C D E F |',
    ]);
  });
});

describe('边界 fixture —— 裸 duration 叶子与 stroke 前缀（UNVERIFIED 家族）', () => {
  it('bare-duration-leaf.jcx：`|||2` 拆成 `||` + `|` + UnknownEvent(duration) `2`，raw 原样（pinned current behaviour, not a spec claim）', () => {
    // §19 的 `|2` 与 §14.4 的 `[CEG]2` 同属「裸 duration 叶子」家族，spec 无条目
    // （Appendix A U26 证据不足）。Domain 只记「这里有一个原文为 `2` 的未知事件」，
    // 不建模「它修饰前面那个小节线」——那是猜语义。
    expect(eventProfile('bare-duration-leaf.jcx')).toEqual([
      'note',
      'barline',
      'barline',
      'unknown(duration):2',
      'note',
      'barline',
    ]);
    // 输出形态：两个 barline 各自断行，孤立的 `2` 起一行。文本与源文本不同形
    // （源文本是 `C2 |||2 D2 |` 一行），但四级矩阵与闭包矩阵都成立。
    expect(canonicalTail('bare-duration-leaf.jcx')).toEqual([
      'V:1',
      '[V:1]',
      'C2 ||',
      '|',
      '2 D2 |',
    ]);
  });

  it('tab-stroke-prefix.jcx：`V[` / `U[` / `B[` 的前缀与悬空前缀当前都不进 Domain，canonical 因此不写回（pinned current behaviour, not a spec claim）', () => {
    // 这是已知限制②（`canonical/body.ts` 文件头）在 fixture 上的钉子。
    // §26.4 的拨弦/扫弦前缀本身是 CONFIRMED 事实，但 parse 层至今不填
    // `TabGroupEvent.stroke`，Domain 里没有这个事实，canonical 无从写回；
    // 悬空 strokePrefix（不紧邻 `[` 的那个 `V` / `B`）更是 UNVERIFIED，方案 §6
    // 第 2 条禁止建模。两者当前都被静默吃掉——本用例把「被吃掉」这件事本身
    // 变成可见的断言：修掉限制②时它会失败。
    expect(eventProfile('tab-stroke-prefix.jcx')).toEqual([
      'tabGroup',
      'tabGroup',
      'barline',
      'tabNote',
      'barline',
    ]);
    const tail = canonicalTail('tab-stroke-prefix.jcx');
    expect(tail).toEqual([
      'V:1 style=tab clef=standardtab',
      '[V:1]',
      '[ax/bx/] [cx/dx/] |',
      'dx/ |',
    ]);
    // 源文本里的 `V[` / `U[` / `B ` / 悬空 `V` 一个都没有出现在输出里。
    expect(tail.join('\n')).not.toContain('V[');
    expect(tail.join('\n')).not.toContain('U[');
    expect(tail.join('\n')).not.toContain('B ');
  });
});

describe('canonical/body.ts 三条已知限制的精确 pin', () => {
  it('限制①：unclosed-chord.jcx 的非法上下文 `|` 是 UnknownEvent(barline)，写回后重解析成普通 barline（pinned current behaviour, not a spec claim）', () => {
    // `roundtrip.test.ts` 的 `L2_KNOWN_LIMITATION` 从投影差异路径那一侧钉这条
    // 限制（差异恰好一处、恰好落在 `$.voices[0].events[3].tokenKind`）。这里从
    // 事件分类那一侧钉同一件事：原文里第 3 个事件是 `UnknownEvent(barline)`，
    // canon1 重解析后它变成正常 `barline`，个数不变、文本不变，只有分类变。
    const before = eventProfile('unclosed-chord.jcx');
    expect(before[3]).toBe('unknown(barline):|');

    const { score } = loadJcx(fixtureBytes('unclosed-chord.jcx'));
    const canonical = serializeJcx(score, { mode: 'canonical' }).text;
    const after = loadJcx(canonical).score.voices[0]?.events ?? [];
    expect(after).toHaveLength(before.length);
    expect(after[3]?.kind).toBe('barline');
  });

  it('限制②：`V[ax/bx/]` 的 `V` 在 Domain 里没有落点（pinned current behaviour, not a spec claim）', () => {
    // 与上面 tab-stroke-prefix.jcx 那条是同一件事的最小复现，直接用文本表达
    // 「前缀进不了 Domain」：两个 tabGroup 完全相同，唯一区别只有源文本里的 `V`。
    const header = '%MUSE2\nX:1\nT:t\nM:4/4\nL:1/8\nK:C\nV:1 style=tab clef=standardtab\n';
    const withPrefix = loadJcx(`${header}[V:1]V[ax/bx/] |\n`).score;
    const withoutPrefix = loadJcx(`${header}[V:1][ax/bx/] |\n`).score;

    expect(withPrefix.voices[0]?.events.map((e) => e.kind)).toEqual(['tabGroup', 'barline']);
    // canonical 输出逐字相等：`V` 这个 CONFIRMED 的事实目前完全没有被记录下来。
    const a = serializeJcx(withPrefix, { mode: 'canonical' }).text;
    const b = serializeJcx(withoutPrefix, { mode: 'canonical' }).text;
    expect(a).toBe(b);
    expect(a).not.toContain('V[');
  });

  it('限制③：`[CEG]2` 的 `2` 是独立 UnknownEvent，canonical 输出 `[CEG] 2`（pinned current behaviour, not a spec claim）', () => {
    // 组级时值后缀在 spec 里没有条目（方案 §5 待拍板 4：不纳入 M1.8，不再周期复议）。
    // parse 把 `2` 落成独立的 `UnknownEvent(duration)`，canonical 因此在 `]` 与 `2`
    // 之间写出一个空格——往返一致，但形态与源文本不同。
    expect(eventProfile('chord-duration.jcx')).toEqual([
      'chord',
      'unknown(duration):2',
      'chord',
      'unknown(duration):/2',
      'chord',
      'unknown(duration):4',
      'barline',
      'chord',
      'unknown(duration):2',
      'chord',
      'unknown(duration):2',
      'barline',
    ]);
    expect(canonicalTail('chord-duration.jcx')).toEqual([
      'V:1',
      '[V:1]',
      '[CEG] 2 [DFA] /2 [ce] 4 |',
      '[CE] 2 [] 2 |',
    ]);
  });
});
