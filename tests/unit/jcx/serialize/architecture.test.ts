/**
 * serialize 模块边界架构守卫（M1.7 方案 v1.1 §1）。
 *
 * `encodeJcx.ts` 钉死 import 白名单；`preserve.ts` 不得 import domain；
 * `canonical/**` 不得 import ast/lexer；`projection/**`（T6）与 canonical 同侧，
 * 只许 import domain 与同目录文件。preserve/canonical 两条规则写在文件不存在时
 * 跳过的形式里（历史原因，等它出现再生效），projection 一条则直接要求非空。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SERIALIZE_DIR = join(import.meta.dirname, '../../../../src/formats/jcx/serialize');

/** 覆盖 `import x from 'm'`、`import type {...} from 'm'`、`export ... from 'm'`、`import('m')`。 */
function collectSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const statik = /\b(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g;
  const bare = /\bimport\s*['"]([^'"]+)['"]/g;
  const dynamic = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [statik, bare, dynamic]) {
    let m = re.exec(source);
    while (m !== null) {
      if (m[1] !== undefined) specs.push(m[1]);
      m = re.exec(source);
    }
  }
  return specs;
}

function collectTsFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('serialize 架构守卫（方案 §1 模块边界表）', () => {
  it('encodeJcx.ts 只 import iconv-lite、../encoding/* 与同目录 ./types', () => {
    const file = join(SERIALIZE_DIR, 'encodeJcx.ts');
    expect(existsSync(file)).toBe(true);

    const specs = collectSpecifiers(readFileSync(file, 'utf8'));
    const bad = specs.filter(
      (spec) =>
        spec !== 'iconv-lite' && !spec.startsWith('../encoding/') && spec !== './types',
    );
    expect(bad).toEqual([]);
  });

  it('preserve.ts 不 import domain（T2 落地前跳过）', () => {
    const file = join(SERIALIZE_DIR, 'preserve.ts');
    if (!existsSync(file)) {
      return;
    }
    const specs = collectSpecifiers(readFileSync(file, 'utf8'));
    const bad = specs.filter((spec) => /(^|\/)domain(\/|$)/.test(spec));
    expect(bad).toEqual([]);
  });

  it('projection/** 只 import domain 与同目录文件（T6）', () => {
    const files = collectTsFiles(join(SERIALIZE_DIR, 'projection'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const specs = collectSpecifiers(readFileSync(file, 'utf8'));
      const bad = specs.filter((spec) => !spec.startsWith('./') && !/(^|\/)domain(\/|$)/.test(spec));
      expect(bad).toEqual([]);
    }
  });

  it('canonical/** 不 import ast/lexer（T3-T5 落地前跳过）', () => {
    const files = collectTsFiles(join(SERIALIZE_DIR, 'canonical'));
    if (files.length === 0) {
      return;
    }
    for (const file of files) {
      const specs = collectSpecifiers(readFileSync(file, 'utf8'));
      const bad = specs.filter(
        (spec) => /(^|\/)ast(\/|$)/.test(spec) || /(^|\/)lexer(\/|$)/.test(spec),
      );
      expect(bad).toEqual([]);
    }
  });
});
