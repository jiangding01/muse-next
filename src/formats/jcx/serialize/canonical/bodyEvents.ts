/**
 * canonical 序列化 —— 事件 → 文本（M1.7 T4，方案 v1.1 §3 / spec §13–§26）。
 *
 * **逐字段重建，不反算**（§9 固定审查项第 5 条）：时值一律写 `durationRaw`
 * 原文，缺省就不写；绝不由 `duration`（`Rational`）反推分数形态——
 * `duration` 是 `durationRaw × unitLength`（broken rhythm 还会再乘倍率）的派生值，
 * 反算出来的文本与原文不是同一个东西。
 *
 * 各形态对应的事实字段：
 * | 事件 | 写法 | 事实来源 |
 * | --- | --- | --- |
 * | note | `^C,2` | `accidental` + `pitch.letter`（`register` 定大小写）+ `pitch.octaveRaw` + `durationRaw` |
 * | rest | `z2` / `Z` / `@` | `variant` + `durationRaw` |
 * | chord | `[CEG]2` 的成员形态 `[` + 成员 + `]` | `members`（成员各自带 `durationRaw`） |
 * | grace | `{G}` / `{@d}` | `after` 决定 `{` 还是 `{@`，`members` |
 * | tabNote | `Va1*2` | `stroke` + 弦字母（`stringIndex` → a..f）+ `fret`（`'x'` 原样）+ `durationRaw`（已含 `*` / `/` 分隔符） |
 * | tabGroup | `V[a1b2]` | `stroke` + `[` + `members` + `]` |
 * | barline | 原样 | `raw`（含 `|1` 这类跳房子形态） |
 * | decoration | `!TRILL!` / 原样 | simple 只存 `name`（`buildDecoration` 已剥掉两侧 `!`），故按 `!${name}!` 重建；complex 有 `raw` |
 * | chordSymbol | `"G"` | `raw`（含两侧引号） |
 * | unknown | 原样 | `raw`（`|||2` 的落单 `2` 就是这么保留的） |
 *
 * **decoration simple 的 `!` 是重建而不是原样**：`Decoration` 的 simple 分支只有
 * `name`（`scanLeaf.buildDecoration` 把 `!TRILL!` 剥成 `TRILL`），Domain 里没有
 * 第二种形态可选——spec §23.1 的记号只有 `!name!` 一种写法，故按它重建，
 * 不算「猜」。complex 分支自带 `raw`，原样写回。
 *
 * 组成员之间**不插空格**（`[CEG]`、`{ab}`），成员级 marker（tie `-`、TAB `-S-`）
 * 由 `bodyRelations` 给出，写在该成员之后、括号内。
 */

import type { EventId, MusicEvent, Note, Pitch, Rest, TabNote } from '../../../../domain';
import { noteRefKey } from '../../../../domain';

/** spec §26.2：第 1–6 弦 → `a`–`f`（`buildTabNote` 的逆映射）。 */
const STRING_LETTERS: readonly string[] = ['a', 'b', 'c', 'd', 'e', 'f'];

function letterOf(pitch: Pitch): string {
  return pitch.register === 'upper' ? pitch.letter : pitch.letter.toLowerCase();
}

function noteText(note: Note): string {
  return `${note.accidental ?? ''}${letterOf(note.pitch)}${note.pitch.octaveRaw ?? ''}${note.durationRaw ?? ''}`;
}

function restText(rest: Rest): string {
  return `${rest.variant}${rest.durationRaw ?? ''}`;
}

function tabNoteText(note: TabNote): string {
  const letter = STRING_LETTERS[note.stringIndex - 1] ?? '';
  const fret = note.fret === 'x' ? 'x' : String(note.fret);
  return `${note.stroke ?? ''}${letter}${fret}${note.durationRaw ?? ''}`;
}

/** 组成员的三种可能类型；用事实字段的存在性判别，不用 `as`。 */
function memberText(member: Note | Rest | TabNote): string {
  if ('pitch' in member) {
    return noteText(member);
  }
  if ('stringIndex' in member) {
    return tabNoteText(member);
  }
  return restText(member);
}

function membersText(
  eventId: EventId,
  members: readonly (Note | Rest | TabNote)[],
  memberSuffix: ReadonlyMap<string, string>,
): string {
  let text = '';
  members.forEach((member, index) => {
    // `noteRefKey` 是 Domain 定义的 `NoteRef` 反查 key，写入侧与读取侧必须同一把钥匙。
    const key = noteRefKey({ eventId, memberIndex: index });
    text += `${memberText(member)}${memberSuffix.get(key) ?? ''}`;
  });
  return text;
}

/** 事件 → canonical 文本（不含 relation marker 的前后缀与分隔符）。 */
export function renderEvent(
  event: MusicEvent,
  memberSuffix: ReadonlyMap<string, string>,
): string {
  switch (event.kind) {
    case 'note':
      return noteText(event.note);
    case 'rest':
      return restText(event.rest);
    case 'chord':
      return `[${membersText(event.id, event.members, memberSuffix)}]`;
    case 'grace':
      return `${event.after ? '{@' : '{'}${membersText(event.id, event.members, memberSuffix)}}`;
    case 'tabNote':
      return tabNoteText(event.note);
    case 'tabGroup':
      return `${event.stroke ?? ''}[${membersText(event.id, event.members, memberSuffix)}]`;
    case 'barline':
      return event.raw;
    case 'decoration':
      return event.decoration.form === 'simple'
        ? `!${event.decoration.name}!`
        : event.decoration.raw;
    case 'chordSymbol':
      return event.symbol.raw;
    case 'unknown':
      return event.raw;
    default: {
      // 十种 kind 已穷尽；新增 kind 会在此处编译失败，而不是运行时静默丢事件。
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}
