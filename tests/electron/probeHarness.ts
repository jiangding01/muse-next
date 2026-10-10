/**
 * Electron runtime codec probe 的最小记录器（M3 T1a，`docs/M3_EDITOR_CORE_PLAN.md` §25.2）。
 *
 * - 每个用例记录 `{ id, pass, detail?, skipped? }`；用例体抛出的异常记为失败（不中断其它用例）。
 * - 不依赖 vitest：本目录的代码会被 vite 打成单文件 CJS，在 `ELECTRON_RUN_AS_NODE=1` 下由 Electron 二进制执行。
 */

export interface ProbeCase {
  readonly id: string;
  readonly pass: boolean;
  readonly detail?: string;
  readonly skipped?: true;
}

export interface Outcome {
  readonly pass: boolean;
  readonly detail?: string;
}

export interface ProbeRecorder {
  readonly cases: readonly ProbeCase[];
  run(id: string, body: () => Outcome | Promise<Outcome>): Promise<void>;
  skip(id: string, reason: string): void;
}

/** 由问题列表得出结论：无问题即通过；`detail` 用于记录事实（如码点）。 */
export function verdict(problems: readonly string[], detail?: string): Outcome {
  if (problems.length > 0) return { pass: false, detail: problems.join('; ') };
  return detail === undefined ? { pass: true } : { pass: true, detail };
}

/** 比较两个可序列化值；不同则把描述追加进 problems。 */
export function expectSame(problems: string[], label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual, bigintReplacer);
  const e = JSON.stringify(expected, bigintReplacer);
  if (a !== e) problems.push(`${label}: expected ${e}, got ${a}`);
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? `${value.toString()}n` : value;
}

export const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');

export const codePoints = (text: string): string =>
  Array.from(text, (char) => `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ');

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message.split('\n')[0] ?? ''}`;
  return String(error);
}

export function createRecorder(): ProbeRecorder {
  const cases: ProbeCase[] = [];
  return {
    cases,
    run: async (id, body) => {
      try {
        const outcome = await body();
        cases.push(outcome.detail === undefined ? { id, pass: outcome.pass } : { id, pass: outcome.pass, detail: outcome.detail });
      } catch (error) {
        cases.push({ id, pass: false, detail: `threw ${describeError(error)}` });
      }
    },
    skip: (id, reason) => {
      cases.push({ id, pass: true, detail: `skipped: ${reason}`, skipped: true });
    },
  };
}
