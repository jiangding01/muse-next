import { describe, expect, it } from 'vitest';
import { createDiagnosticBag } from '../../../src/formats/jcx/lexer/diagnostics';
import type { JcxDiagnostic } from '../../../src/formats/jcx/lexer/diagnostics';
import { lexBodyPitch } from '../../../src/formats/jcx/lexer/lexBodyPitch';
import { lexBodyTab } from '../../../src/formats/jcx/lexer/lexBodyTab';
import type { SourcePosition, SourceSpan } from '../../../src/formats/jcx/lexer/sourceSpan';

/**
 * diagnostics 收集器与两个 body lexer 的诊断契约（方案 §5 / §7 T6）。
 *
 * 铁律回归：收集器永不抛异常；Lexer 阶段不产生 `error` 级（留给 Parser）。
 */
const BASE: SourcePosition = { offset: 0, line: 1, column: 0 };

function spanAt(start: number, end: number): SourceSpan {
  return {
    start: { offset: start, line: 1, column: start },
    end: { offset: end, line: 1, column: end },
  };
}

function collect(
  lexer: (text: string, base: SourcePosition, bag: ReturnType<typeof createDiagnosticBag>) => unknown,
  input: string,
): readonly JcxDiagnostic[] {
  const bag = createDiagnosticBag();
  lexer(input, BASE, bag);
  return bag.list();
}

describe('createDiagnosticBag', () => {
  it('report 按调用顺序累积，list 返回全部条目的快照', () => {
    const bag = createDiagnosticBag();
    bag.report('jcx.field.unknown', 'warning', 'first', spanAt(0, 1));
    bag.report('jcx.rest.hidden', 'info', 'second', spanAt(2, 3));

    expect(bag.list()).toEqual([
      { code: 'jcx.field.unknown', severity: 'warning', message: 'first', span: spanAt(0, 1) },
      { code: 'jcx.rest.hidden', severity: 'info', message: 'second', span: spanAt(2, 3) },
    ]);
  });

  it('add 接受完整 diagnostic 对象，与 report 混用时顺序一致', () => {
    const bag = createDiagnosticBag();
    bag.add({
      code: 'jcx.directive.unknown',
      severity: 'info',
      message: 'added',
      span: spanAt(0, 2),
    });
    bag.report('jcx.body.unknown-token', 'warning', 'reported', spanAt(3, 4));

    expect(bag.list().map((d) => d.code)).toEqual([
      'jcx.directive.unknown',
      'jcx.body.unknown-token',
    ]);
  });

  it('list 是快照：对返回值的引用不受后续 report 影响', () => {
    const bag = createDiagnosticBag();
    bag.report('jcx.field.unknown', 'warning', 'first', spanAt(0, 1));
    const snapshot = bag.list();
    bag.report('jcx.field.unknown', 'warning', 'second', spanAt(1, 2));

    expect(snapshot).toHaveLength(1);
    expect(bag.list()).toHaveLength(2);
  });

  it('hasSeverity 只按 severity 判定，空 bag 一律 false', () => {
    const bag = createDiagnosticBag();
    expect(bag.hasSeverity('error')).toBe(false);
    expect(bag.hasSeverity('warning')).toBe(false);

    bag.report('jcx.rest.uppercase-z', 'info', 'z', spanAt(0, 1));
    expect(bag.hasSeverity('info')).toBe(true);
    expect(bag.hasSeverity('warning')).toBe(false);

    bag.report('jcx.body.unknown-token', 'warning', 'w', spanAt(1, 2));
    expect(bag.hasSeverity('warning')).toBe(true);
    expect(bag.hasSeverity('error')).toBe(false);
  });
});

describe('未知 body token 的 code / severity / span', () => {
  it('pitch 模式：未知字符发 warning，span 精确覆盖该片段', () => {
    const diags = collect(lexBodyPitch, 'C#D');
    expect(diags).toEqual([
      {
        code: 'jcx.body.unknown-token',
        severity: 'warning',
        message: "unrecognized body token '#'",
        span: spanAt(1, 2),
      },
    ]);
  });

  it('tab 模式：未知字符同样只发 warning，不中止整行', () => {
    const diags = collect(lexBodyTab, 'a1#b2');
    expect(diags.map((d) => [d.code, d.severity, d.span.start.offset, d.span.end.offset])).toEqual([
      ['jcx.body.unknown-token', 'warning', 2, 3],
    ]);
  });

  it('两个 lexer 都不产生 error 级（Lexer 阶段铁律）', () => {
    for (const diags of [collect(lexBodyPitch, 'C#D@Z'), collect(lexBodyTab, 'a1#.Z@')]) {
      expect(diags.every((d) => d.severity !== 'error')).toBe(true);
    }
  });
});

describe("'Z' 在两种模式下的诊断差异", () => {
  it('pitch 模式：Z 是 rest，发 info（§15.2 语义 UNVERIFIED）', () => {
    expect(collect(lexBodyPitch, 'Z')).toEqual([
      {
        code: 'jcx.rest.uppercase-z',
        severity: 'info',
        message: "rest 'Z' has unverified semantics; it is not ABC's multi-measure rest",
        span: spanAt(0, 1),
      },
    ]);
  });

  it('pitch 模式：小写 z 不发任何诊断', () => {
    expect(collect(lexBodyPitch, 'z')).toEqual([]);
  });

  it('tab 模式：Z 同为 rest（§26.9 共享构造），发同一条 info', () => {
    expect(collect(lexBodyTab, 'Z').map((d) => [d.code, d.severity])).toEqual([
      ['jcx.rest.uppercase-z', 'info'],
    ]);
  });

  it('tab 模式：小写 z 同样静默（语料 28 处 TAB 休止）', () => {
    expect(collect(lexBodyTab, 'a1 z')).toEqual([]);
  });
});

describe("'@' 在两种模式下的诊断差异", () => {
  it('pitch 模式：裸 @ 是隐藏休止符，发 info（DOC-ONLY）', () => {
    expect(collect(lexBodyPitch, '@')).toEqual([
      {
        code: 'jcx.rest.hidden',
        severity: 'info',
        message: "hidden rest '@' is DOC-ONLY (zero corpus samples)",
        span: spanAt(0, 1),
      },
    ]);
  });

  it('pitch 模式：{@ 与 !…@…! 内的 @ 已被更高优先级吃掉，不发 hidden-rest', () => {
    expect(collect(lexBodyPitch, '{@C}')).toEqual([]);
    expect(collect(lexBodyPitch, "!@y'10'$f'SimSun'$s'15'A!")).toEqual([]);
  });

  it('tab 模式：@ 无定义 → warning', () => {
    expect(collect(lexBodyTab, 'a1@').map((d) => [d.code, d.severity])).toEqual([
      ['jcx.body.unknown-token', 'warning'],
    ]);
  });
});

describe('§26.4 悬空拨弦前缀', () => {
  it('tab 模式：未紧跟音符的前缀发 info 而非 warning', () => {
    expect(collect(lexBodyTab, 'S |').map((d) => [d.code, d.severity, d.span.start.offset])).toEqual([
      ['jcx.tab.dangling-stroke-prefix', 'info', 0],
    ]);
  });

  it('紧跟弦组 / 弦字母的前缀不发任何诊断', () => {
    expect(collect(lexBodyTab, 'V[ax/]Ba1')).toEqual([]);
  });
});
