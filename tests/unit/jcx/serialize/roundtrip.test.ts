/**
 * JCX round-trip 测试矩阵（M1.7 T6，方案 v1.1 §6）。
 *
 * 对 `tests/fixtures/jcx/**\/*.jcx` 全体（运行时 glob，数量不写死）跑四级：
 *
 * | 级别 | 断言 |
 * | --- | --- |
 * | L1 parse | `loadJcx(bytes)` 无 `error` 级 diagnostic |
 * | L2 语义 | `project(parse(x))` toEqual `project(parse(canonical(parse(x))))`，且原始投影无悬空引用 |
 * | L3 preserve | `serializeJcx(loadResult, {mode:'preserve'}).bytes` === 原字节 |
 * | 幂等 | `canonical(parse(canonical(x))) === canonical(x)` |
 *
 * L3 的细分用例（显式编码转换、span 失效守卫、两种输入形态）在
 * `preserve.test.ts`；本文件只保留矩阵那一格，让四级能在同一处一眼看全。
 *
 * ## L2 的唯一豁免
 *
 * `unclosed-chord.jcx` —— `canonical/body.ts` 文件头「已知限制①」：未闭合 `[`
 * 里的 `|` 在原文里是 `UnknownEvent(tokenKind: 'barline')`（词法扫描上下文非法），
 * canonical 原样写回 `|` 后脱离了那个非法上下文，重解析成正常 `barline`。
 * 文本一致、事件个数一致，只是分类变了。
 *
 * **限制①本身仍然成立**：原始 → canon1 的 `tokenKind` 分类漂移没有被修掉，下面的
 * `L2_KNOWN_LIMITATION` 继续钉着那一处差异路径。被修掉的是它**曾经**的连带后果：
 * 分类变了之后断行规则跟着变，这一个 fixture 的幂等一度是「从第二趟起稳定」。
 * M1.8 T1 起 `canonical/body.ts` 的 `breaksLineAfter`（唯一 approved 的 src 例外）
 * 把 `UnknownEvent(tokenKind:'barline')` 也算作断行点，canon1 起即为不动点，幂等
 * 那一格已与其余 fixture 同一条断言（见 `roundtrip.closure.test.ts` 的闭包矩阵）。
 * 两件事不要混为一谈：L2 豁免还在，不动点问题已消失。
 *
 * 豁免用**点名 + 钉死差异位置**的方式表达（下面的用例断言「差异恰好只有那一处」），
 * 而不是放宽投影：放宽投影会让**所有** fixture 的同类差异一起消失，等于把一处已知
 * 缺陷兑换成一张全局的空头承诺。若哪天这条限制被修掉，这个用例会失败，提醒把
 * fixture 从豁免名单里移走。
 */

import { describe, expect, it } from 'vitest';

import { loadJcx } from '../../../../src/formats/jcx';
import { serializeJcx } from '../../../../src/formats/jcx/serialize';
import { projectScore } from '../../../../src/formats/jcx/serialize';
import {
  canonicalTrip,
  cleanFixtureNames,
  collectUnresolvedRefPaths,
  errorDiagnostics,
  fixtureBytes,
  fixtureNames,
  malformedFixtureNames,
} from './roundtrip.helpers';
import {
  checkIdempotent,
  checkL1,
  checkL2,
  checkL3,
  checkReparseClean,
  L2_KNOWN_LIMITATION,
} from './fixtureMatrix';

/** 对一段 canonical 文本再 canonical 一次（只有已知限制那一例需要看第三趟）。 */
function canonicalAgain(text: string): string {
  return serializeJcx(loadJcx(text).score, { mode: 'canonical' }).text;
}

const l2Names = fixtureNames.filter((name) => !(name in L2_KNOWN_LIMITATION));

it('fixture 集合非空（空集不得被当成全绿）', () => {
  expect(fixtureNames.length).toBeGreaterThan(0);
  expect(l2Names.length).toBeGreaterThan(0);
});

it('reparse health 分组之和等于 fixture 总数（M1.8 T0，防空集）', () => {
  expect(cleanFixtureNames.length + malformedFixtureNames.length).toBe(fixtureNames.length);
  expect(cleanFixtureNames.length).toBeGreaterThan(0);
});

describe.each(fixtureNames)('round-trip 矩阵: %s', (name) => {
  it('L1 parse：无 error 级 diagnostic', () => {
    expect(checkL1(name)).toBe(true);
  });

  it('L2 前哨：原始投影里没有任何悬空引用（两侧同时悬空不得被判相等）', () => {
    const trip = canonicalTrip(name);
    expect(collectUnresolvedRefPaths(trip.before)).toEqual([]);
  });

  it('L3 preserve：bytes 与原字节逐字节相等', () => {
    expect(checkL3(name)).toBe(true);
  });

  it('幂等：canonical(parse(canonical(x))) === canonical(x)', () => {
    const trip = canonicalTrip(name);
    expect(checkIdempotent(name)).toBe(true);
    if (name in L2_KNOWN_LIMITATION) {
      // 限制①**曾经**的连带后果（M1.8 T1 之前）：第一趟把 `UnknownEvent(barline)`
      // 写成普通 `|` 之后，第二趟才按「小节线后断行」重新切行，所以第 1 → 2 趟
      // 不相等，这里原先断言的是「从第二趟起稳定」。`canonical/body.ts` 的
      // `breaksLineAfter` 把这类 `UnknownEvent` 也算作断行点之后，canon1 起就是
      // 不动点，因此这一例改用与其余 fixture 相同的断言，并额外把第三趟也钉住
      // ——收紧，不是放宽。
      expect(canonicalAgain(trip.canonicalTwice)).toBe(trip.canonicalText);
    }
  });
});

describe.each(l2Names)('L2 语义 round-trip: %s', (name) => {
  it('project(parse(x)) === project(parse(canonical(parse(x))))', () => {
    const trip = canonicalTrip(name);
    // 先报路径（失败时一眼看到是哪个字段），再用 toEqual 出完整 diff。
    expect(checkL2(name).diffPath).toBeNull();
    expect(trip.after).toEqual(trip.before);
  });
});

describe.each(cleanFixtureNames)('reparse health（原始输入无 error 级，硬门槛）: %s', (name) => {
  it('canonical 输出重解析后无 error 级 diagnostic', () => {
    expect(checkReparseClean(name).ok).toBe(true);
  });
});

describe.each(malformedFixtureNames)('reparse health（原始输入含 error 级，仅观测）: %s', (name) => {
  it('observed：canonical 输出重解析后的 error 级 diagnostic 数量（不设硬门槛）', () => {
    // 原始输入本身已带 error 级 diagnostic（malformed/recovery 样本），canonical
    // 如何写回一段合法性存疑的输入不是本里程碑要回答的问题——这里只记录数字，
    // 不断言，it 标题已注明 observed。当前语料/fixture 集合下这一组为空集
    // （`malformedFixtureNames.length === 0`），保留这条 describe.each 是为了
    // 在未来出现 malformed fixture 时自动纳入观测而不需要改动测试结构。
    expect(checkReparseClean(name).errorCount).toBeGreaterThanOrEqual(0);
  });
});

it('契约哨兵：全部 fixture 的 canonical diagnostics 无 error 级（canonical renderer warning-only 契约）', () => {
  for (const name of fixtureNames) {
    const trip = canonicalTrip(name);
    expect(errorDiagnostics(trip.canonicalDiagnostics)).toEqual([]);
  }
});

describe('L2 已知限制（canonical/body.ts 限制①）', () => {
  it.each(Object.entries(L2_KNOWN_LIMITATION))(
    '%s 的投影差异恰好只有一处，且落在记录在案的位置：%s',
    (name, path) => {
      const check = checkL2(name);
      expect(check.diffPath).toBe(path);
      expect(check.matchesKnownLimitation).toBe(true);
    },
  );

  it('豁免名单里的 fixture 都真实存在（改名后名单不得变成哑弹）', () => {
    for (const name of Object.keys(L2_KNOWN_LIMITATION)) {
      expect(fixtureNames).toContain(name);
    }
  });
});

describe('悬空引用前哨自身不是哑弹', () => {
  it('collectUnresolvedRefPaths 能在嵌套结构里找出 { unresolved: true } 并报出路径', () => {
    const planted = { voices: [{ ties: [{ from: { unresolved: true }, to: null }] }] };
    expect(collectUnresolvedRefPaths(planted)).toEqual(['$.voices[0].ties[0].from']);
    // `status: 'unresolved'` 是字符串值，不是悬空引用，不得误报。
    expect(collectUnresolvedRefPaths({ ties: [{ status: 'unresolved' }] })).toEqual([]);
  });
});

describe('公开 API serializeJcx(score, { mode: "canonical" })', () => {
  it('固定输出形态：UTF-8 / 无 BOM / LF / 末尾换行，bytes 与 text 一致', () => {
    const { score } = loadJcx(fixtureBytes('lyrics.jcx'));
    const result = serializeJcx(score, { mode: 'canonical' });

    expect(result.encoding).toBe('utf-8');
    expect(result.text.startsWith('﻿')).toBe(false);
    expect(Array.from(result.bytes.slice(0, 3))).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(result.text).not.toContain('\r');
    expect(result.text.endsWith('\n')).toBe(true);
    expect(Array.from(result.bytes)).toEqual(Array.from(new TextEncoder().encode(result.text)));
  });

  it('magicHeader:false 只去掉 %MUSE2 那一行，其余输出不变', () => {
    const { score } = loadJcx(fixtureBytes('lyrics.jcx'));
    const withHeader = serializeJcx(score, { mode: 'canonical' });
    const without = serializeJcx(score, { mode: 'canonical', magicHeader: false });

    expect(withHeader.text.startsWith('%MUSE2\n')).toBe(true);
    expect(without.text.startsWith('%MUSE2')).toBe(false);
    expect(without.text).toBe(withHeader.text.slice('%MUSE2\n'.length));
    // 关掉 magic header 不改变语义：L2 仍然相等。
    expect(projectScore(loadJcx(without.text).score)).toEqual(projectScore(score));
  });

  it('diagnostics 汇总 renderer 的告警（canonical 恒 UTF-8，encoder 无话可说）', () => {
    const { score } = loadJcx(fixtureBytes('tab-relation-group-endpoints.jcx'));
    const result = serializeJcx(score, { mode: 'canonical' });

    expect(result.diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.code.startsWith('jcx.serialize.')).toBe(true);
      expect(diagnostic.severity).toBe('warning');
    }
    expect(result.diagnostics.some((d) => d.code === 'jcx.serialize.tab-relation-member-position')).toBe(
      true,
    );
  });

  it('diagnostics 也会带出 encoder 的告警（preserve + GB18030 + replace）', () => {
    // canonical 恒 UTF-8，编码不出的字符不存在；encoder 诊断只能从 preserve 这条
    // 分支验证——但它与 canonical 走的是同一个 `encodeJcx`，同一条汇总路径。
    // 孤立代理项：GB18030 覆盖全部合法 Unicode 标量值（emoji 也能编码），
    // 编不出来的只有不成对的代理项。
    const loaded = loadJcx('X:1\nT:\uD800\nK:C\n');
    const result = serializeJcx(loaded, {
      mode: 'preserve',
      encoding: 'gb18030',
      onUnencodable: 'replace',
    });

    expect(result.diagnostics.map((d) => d.code)).toContain('jcx.serialize.unencodable-replaced');
  });
});
