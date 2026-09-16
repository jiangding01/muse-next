/**
 * notation/layout —— D12 方案 B 的保守占位摘要（M2 方案 v1.1.1 §3.0 / §5.0 D12，T5 修订）。
 *
 * `voice.style` 缺席或未知时，`ScoreView` 不假装是任何一种记谱法，只画一条
 * 「未声明风格」的事件条带（§3.0）。**把这段摘要逻辑从 `ScoreView.tsx` 移到这里**
 * （而不是让 React 组件直接解释 `MusicEvent` 的十个分支）：React 组件只应该消费
 * 已经算好的字符串，"哪个 Domain 字段对应哪段文本"是一个纯粹的、该被单测覆盖的
 * 判断，留在 `.tsx` 里既测不到（要么引入 jsdom，要么靠 smoke 间接盖到），也会让
 * `ScoreView` 承担本不该属于它的职责。
 *
 * **只做文本化转述，不解释语义**：`Rest.variant`（`z` / `Z` / `@`）**原样显示**，
 * 不改写成简谱的 `0`——把 `z` 显示成 `0` 会让这条保守占位看起来像是在用简谱规则
 * 渲染，而这正是 D12 要避免的「让用户看到一份看起来权威、实则建立在猜测上的谱面」。
 *
 * 本文件不含任何尺寸常量（`svg.test.ts` 的 P2-2 守卫会扫到 `src/notation/layout/**`
 * 下的顶层裸数字），纯文本转述不需要几何数值。
 */

import type { MusicEvent, Pitch } from '../../domain';

/** `letter` 按 `register` 大小写化，八度修饰原样带上 `octaveRaw`（不重新解释混合方向）。 */
export function summarizePitch(pitch: Pitch): string {
  const letter = pitch.register === 'upper' ? pitch.letter : pitch.letter.toLowerCase();
  return letter + (pitch.octaveRaw ?? '');
}

/** 和弦/组内成员（`Note | Rest`）的单字符摘要，供 `summarizeEvent` 的 chord 分支复用。 */
function summarizeMember(member: { readonly pitch: Pitch } | { readonly variant: string }): string {
  return 'pitch' in member ? summarizePitch(member.pitch) : member.variant;
}

/**
 * 单个事件的最小文本摘要：音高字母、休止原始变体字符、小节线原文等。**不假装是
 * 任何一种记谱法**——`chord`/`tabGroup` 只是方括号包住成员摘要，不画时值/梁线。
 */
export function summarizeEvent(event: MusicEvent): string {
  switch (event.kind) {
    case 'note':
      return summarizePitch(event.note.pitch);
    case 'rest':
      // `z` / `Z` / `@` 原样显示，不改写成简谱的 `0`（见文件头）。
      return event.rest.variant;
    case 'chord':
      return `[${event.members.map(summarizeMember).join('')}]`;
    case 'grace':
      return '~';
    case 'barline':
      return event.raw;
    case 'decoration':
      return event.decoration.form === 'simple' ? `!${event.decoration.name}!` : '!...!';
    case 'chordSymbol':
      return `"${event.symbol.raw}"`;
    case 'tabNote':
      return String(event.note.fret);
    case 'tabGroup':
      return `[${event.members.map((member) => String(member.fret)).join('')}]`;
    case 'unknown':
      return event.raw;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/** 一个声部的事件摘要，按顺序以空格连接——D12 保守占位条带的正文内容。 */
export function summarizeEvents(events: readonly MusicEvent[]): string {
  return events.map(summarizeEvent).join(' ');
}
