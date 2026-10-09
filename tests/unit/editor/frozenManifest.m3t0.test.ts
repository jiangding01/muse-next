/**
 * M3 冻结文件哈希清单守卫（`docs/M3_EDITOR_CORE_PLAN.md` §21.3，T0 用户裁决：414 个既有冻结文件）。
 *
 * - 不依赖 git diff / git history（CI 为浅克隆）：逐项读文件、按清单记录的模式重算 SHA-256 并比对。
 * - `raw`：原始字节；`norm`：字节级 CRLF → LF、孤立 CR → LF 后再哈希。都不做 UTF-8 解码。
 * - 模式只来自清单，测试不按扩展名猜；清单与 `.gitattributes` 的已知规则必须一致。
 * - 哈希实现与生成脚本 `scripts/m3/frozenManifest.ts` 相互独立，二者互为校验。
 * - 更新清单必须经用户显式裁决。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from './staticAnalysis';

interface ManifestEntry {
  readonly path: string;
  readonly mode: string;
  readonly sha256: string;
}

const BASELINE = 'c04626010a7f8bda67ffac6e5c92ef68e2440235';
const RAW_RULE = /^tests\/fixtures\/jcx\/(?:.+\/)?[^/]+\.jcx$/;
/** 用户批准的 C1–C9 成员规则（目录前缀以 `/` 结尾，否则为精确路径），与生成脚本独立维护、互为校验。 */
const APPROVED_RULES = [
  'src/formats/jcx/',
  'src/domain/',
  'src/notation/',
  ...['SystemView.tsx', 'StaffSystemView.tsx', 'systemRender.ts', 'systemSlices.ts', 'SvgTree.tsx', 'ChordDiagram.tsx', 'ScoreHeaderView.tsx'].map(
    (name) => `src/renderer/components/notation/${name}`,
  ),
  'src/renderer/integrations/vexflow/',
  'tests/unit/jcx/',
  'tests/unit/domain/',
  'tests/unit/notation/',
  'tests/unit/renderer/',
  'tests/fixtures/',
  'scripts/jcx/',
  'scripts/notation/t5-default-golden.ts',
  'scripts/notation/beam-regression-golden.ts',
  '.gitattributes',
];
const approved = (path: string): boolean => APPROVED_RULES.some((rule) => (rule.endsWith('/') ? path.startsWith(rule) : path === rule));

/** T0 新增的位置：任何一项都不得出现在历史冻结清单里。 */
const T0_NEW_LOCATIONS = ['src/editor/', 'src/formats/jcxParse.ts', 'src/shared/documentContracts.ts', 'tests/unit/editor/', 'scripts/m3/'];

function normalize(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if (byte === 0x0d) {
      out.push(0x0a);
      if (bytes[i + 1] === 0x0a) i += 1;
    } else if (byte !== undefined) {
      out.push(byte);
    }
  }
  return Uint8Array.from(out);
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const hashAs = (bytes: Uint8Array, mode: string): string => sha256(mode === 'raw' ? bytes : normalize(bytes));

function readManifest(): { schemaVersion: unknown; baselineCommit: unknown; files: ManifestEntry[] } {
  const parsed: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'tests/unit/editor/m3FrozenManifest.json'), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('files' in parsed) || !Array.isArray(parsed.files)) {
    throw new Error('清单结构非法：缺少 files 数组');
  }
  const files = parsed.files.map((item: unknown): ManifestEntry => {
    if (typeof item !== 'object' || item === null || !('path' in item) || !('mode' in item) || !('sha256' in item)) {
      throw new Error('清单项缺少 path / mode / sha256');
    }
    const { path, mode, sha256: hash } = item;
    if (typeof path !== 'string' || typeof mode !== 'string' || typeof hash !== 'string') throw new Error('清单项字段类型非法');
    return { path, mode, sha256: hash };
  });
  return {
    schemaVersion: 'schemaVersion' in parsed ? parsed.schemaVersion : undefined,
    baselineCommit: 'baselineCommit' in parsed ? parsed.baselineCommit : undefined,
    files,
  };
}

const manifest = readManifest();

describe('M3 T0 —— 冻结文件哈希清单（§21.3）', () => {
  it('元数据：schemaVersion 1，基线为 c046260', () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.baselineCommit).toBe(BASELINE);
  });

  it('按 path 字典序严格递增（因此无重复）；模式只有 raw / norm；SHA-256 格式合法', () => {
    for (let i = 1; i < manifest.files.length; i += 1) {
      const previous = manifest.files[i - 1]?.path ?? '';
      const current = manifest.files[i]?.path ?? '';
      expect(previous < current, `${previous} !< ${current}`).toBe(true);
    }
    for (const entry of manifest.files) {
      expect(['raw', 'norm'], entry.path).toContain(entry.mode);
      expect(entry.sha256, entry.path).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('数量与用户批准一致：414 个，其中 raw 105、norm 309；raw 恰好对应 .gitattributes 的 -text 规则', () => {
    expect(manifest.files).toHaveLength(414);
    expect(manifest.files.filter((entry) => entry.mode === 'raw')).toHaveLength(105);
    expect(manifest.files.filter((entry) => entry.mode === 'norm')).toHaveLength(309);
    for (const entry of manifest.files) expect(entry.mode === 'raw', entry.path).toBe(RAW_RULE.test(entry.path));
  });

  it('每一项都属于用户批准的 C1–C9 规则（不依赖 git）', () => {
    expect(manifest.files.filter((entry) => !approved(entry.path)).map((entry) => entry.path)).toEqual([]);
  });

  it('不包含任何 T0 新增文件', () => {
    const leaked = manifest.files.filter((entry) => T0_NEW_LOCATIONS.some((loc) => (loc.endsWith('/') ? entry.path.startsWith(loc) : entry.path === loc)));
    expect(leaked).toEqual([]);
  });

  it.each(manifest.files.map((entry) => [entry.path, entry]))('%s 存在且哈希与清单一致', (_path, entry) => {
    const file = join(REPO_ROOT, entry.path);
    expect(existsSync(file), `冻结文件缺失：${entry.path}`).toBe(true);
    expect(hashAs(readFileSync(file), entry.mode)).toBe(entry.sha256);
  });
});

describe('M3 T0 —— 哈希模式的反例（变异必须被杀死）', () => {
  const crlf = Uint8Array.from([0x61, 0x0d, 0x0a, 0x62, 0x0d, 0x0a]);
  const lf = Uint8Array.from([0x61, 0x0a, 0x62, 0x0a]);

  it('raw：CRLF → LF 会改变哈希（CRLF fixture 被改成 LF 时守卫失败）', () => {
    expect(hashAs(crlf, 'raw')).not.toBe(hashAs(lf, 'raw'));
  });

  it('norm：Windows autocrlf 检出的 CRLF 与仓库中的 LF 哈希相同（不误报）', () => {
    expect(hashAs(crlf, 'norm')).toBe(hashAs(lf, 'norm'));
  });

  it('norm 是字节级规范化：孤立 CR → LF，CR CR LF → LF LF，其余字节不变', () => {
    expect([...normalize(Uint8Array.from([0x61, 0x0d, 0x62]))]).toEqual([0x61, 0x0a, 0x62]);
    expect([...normalize(Uint8Array.from([0x0d, 0x0d, 0x0a]))]).toEqual([0x0a, 0x0a]);
    expect([...normalize(Uint8Array.from([0x0d]))]).toEqual([0x0a]);
  });

  it('非 UTF-8 字节（GB18030）按字节哈希，不经解码：改一个字节哈希即变', () => {
    const gb = Uint8Array.from([0x84, 0x31, 0x95, 0x33, 0xc4, 0xe3, 0xba, 0xc3]);
    const mutated = Uint8Array.from([0x84, 0x31, 0x95, 0x33, 0xc4, 0xe3, 0xba, 0xc4]);
    expect(hashAs(gb, 'raw')).not.toBe(hashAs(mutated, 'raw'));
    expect(hashAs(gb, 'norm')).not.toBe(hashAs(mutated, 'norm'));
  });
});
