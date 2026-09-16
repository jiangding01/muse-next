/**
 * round-trip 矩阵的共用夹具（M1.7 T6，方案 v1.1 §6）。
 *
 * 只放「读 fixture / 跑一趟 canonical / 遍历投影」这类无断言的机械操作，断言全部
 * 留在 `roundtrip.test.ts` 里——夹具里藏断言会让失败信息指向夹具而不是用例。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import { loadJcx } from '../../../../src/formats/jcx';
import type { JcxDiagnostic } from '../../../../src/formats/jcx/lexer/diagnostics';
import { serializeJcx } from '../../../../src/formats/jcx/serialize';
import type { ProjectedScore } from '../../../../src/formats/jcx/serialize';
import { projectScore } from '../../../../src/formats/jcx/serialize';

export const FIXTURES_DIR = resolve(__dirname, '../../../fixtures/jcx');

function listFixtureFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listFixtureFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.jcx')) {
      found.push(full);
    }
  }
  return found.sort();
}

/**
 * 相对 `tests/fixtures/jcx` 的路径清单（运行时 glob，数量不写死）。
 * 分隔符统一为 `/`：Windows 上 `relative` 产出 `encoding\bom-crlf.jcx`，
 * 会让按名字点名 fixture 的测试与 pinned limitation 名单跨平台不一致
 * （CI run 35054050143 windows-latest 实测）；`resolve` 两种分隔符都接受。
 */
export const fixtureNames: readonly string[] = listFixtureFiles(FIXTURES_DIR).map((full) =>
  relative(FIXTURES_DIR, full).split(sep).join('/'),
);

export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(FIXTURES_DIR, name)));
}

export interface CanonicalTrip {
  /** 原字节解析出的投影。 */
  readonly before: ProjectedScore;
  /** canonical 文本重解析后的投影。 */
  readonly after: ProjectedScore;
  readonly canonicalText: string;
  /** 对 canonical 文本再 canonical 一次的结果（幂等断言用）。 */
  readonly canonicalTwice: string;
  /** `serializeJcx(source, {mode:'canonical'}).diagnostics`（契约哨兵用，M1.8 T0）。 */
  readonly canonicalDiagnostics: readonly JcxDiagnostic[];
  /** canonical 文本重解析（`loadJcx(canonicalText)`）产出的 diagnostics（reparse health 用，M1.8 T0）。 */
  readonly reparsedDiagnostics: readonly JcxDiagnostic[];
}

/** `bytes → parse → canonical → parse`，一次跑完 L2、幂等、reparse health 所需的全部素材。 */
export function canonicalTrip(name: string): CanonicalTrip {
  const source = loadJcx(fixtureBytes(name)).score;
  const canonicalResult = serializeJcx(source, { mode: 'canonical' });
  const canonicalText = canonicalResult.text;
  const reparsed = loadJcx(canonicalText);
  return {
    before: projectScore(source),
    after: projectScore(reparsed.score),
    canonicalText,
    canonicalTwice: serializeJcx(reparsed.score, { mode: 'canonical' }).text,
    canonicalDiagnostics: canonicalResult.diagnostics,
    reparsedDiagnostics: reparsed.diagnostics,
  };
}

/** 只筛出 `severity === 'error'` 的 diagnostic（reparse health / 契约哨兵共用）。 */
export function errorDiagnostics(diagnostics: readonly JcxDiagnostic[]): readonly JcxDiagnostic[] {
  return diagnostics.filter((d) => d.severity === 'error');
}

/**
 * 原始输入 parse 是否无 error 级 diagnostic（M1.8 T0 分组判据）。
 *
 * 为 `true` 的 fixture 归入 clean 组——canonical 输出重解析 error=0 是硬门槛；
 * 为 `false` 的归入 malformed 组——只观测，不设硬门槛（原文本身已经带 error，
 * canonical 如何写回一段合法性存疑的输入不属于本里程碑要回答的问题）。
 */
export function isOriginalClean(name: string): boolean {
  return errorDiagnostics(loadJcx(fixtureBytes(name)).diagnostics).length === 0;
}

export const cleanFixtureNames: readonly string[] = fixtureNames.filter((name) => isOriginalClean(name));
export const malformedFixtureNames: readonly string[] = fixtureNames.filter(
  (name) => !isOriginalClean(name),
);

/**
 * 收集投影里所有 `{ unresolved: true }` 引用的字段路径。
 *
 * L2 断言的形式是「两侧投影相等」，而**两侧同时悬空**也满足相等——引用归一化
 * 一旦整体失灵（比如索引没建起来），矩阵会安静地全绿。因此对 before 侧（原字节
 * 解析出的投影）单独断言「一个悬空引用都没有」：parse 层产出的引用必然指向本
 * 声部内真实存在的事件（`corpus-lex-test.ts` 断言⑬ 同源），出现悬空就说明是
 * 投影自己丢了目标，而不是数据本来如此。
 */
export function collectUnresolvedRefPaths(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectUnresolvedRefPaths(item, `${path}[${String(index)}]`),
    );
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  const record: Record<string, unknown> = { ...value };
  if (record.unresolved === true) {
    return [path];
  }
  return Object.keys(record).flatMap((key) =>
    collectUnresolvedRefPaths(record[key], `${path}.${key}`),
  );
}
