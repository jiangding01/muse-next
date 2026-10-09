/**
 * 测试用的极小确定性伪随机数生成器（mulberry32），不引入 fast-check 等依赖（T0 裁决 T0-11）。
 * 性质测试失败时必须在断言消息里带上 seed 与 case 下标，保证可复现。
 */

export interface Prng {
  /** [0, 1) 浮点数。 */
  readonly next: () => number;
  /** [0, maxExclusive) 整数。 */
  readonly int: (maxExclusive: number) => number;
  /** 从非空数组中取一个元素。 */
  readonly pick: <T>(items: readonly T[]) => T;
}

export function createPrng(seed: number): Prng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (maxExclusive: number): number => Math.floor(next() * maxExclusive);
  const pick = <T,>(items: readonly T[]): T => {
    const item = items[int(items.length)];
    if (item === undefined) throw new Error('pick: 空数组');
    return item;
  };
  return { next, int, pick };
}

/** 由字母表随机拼出长度不超过 `maxLength` 的字符串。 */
export function randomText(prng: Prng, alphabet: readonly string[], maxLength: number): string {
  const length = prng.int(maxLength + 1);
  let text = '';
  for (let i = 0; i < length; i += 1) text += prng.pick(alphabet);
  return text;
}
