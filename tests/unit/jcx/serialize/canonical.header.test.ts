/**
 * canonical 骨架回归（M1.7 T3，方案 v1.1 §3 / §8 / spec §27.3）。
 *
 * 22 例中 20 例走**真实链路** `loadJcx(源文本).score → serializeCanonical(score, …)`，
 * 不手工构造 Score——这样断言的是「解析出来的事实能不能原样写回」，
 * 而不是「渲染函数对我编的对象做了什么」。只有「值同时含空白与 `"`」的两例
 * 直接构造 Domain：那种值**解析不出来**（见该用例注释），是 canonical 的已知
 * limitation（无法保证 reparse 等价），只能这样覆盖。
 *
 * 入口选择：body（事件 / relation / 歌词）要到 T4/T5 才有，**公开的
 * `serializeJcx(score, {mode:'canonical'})` 在此之前必须抛错**（不能返回没有
 * 正文的「合法」文件），所以本文件直接调内部的 `serializeCanonical`，
 * 并单独断言公开分支仍然抛错。body 由 T4/T5 落地，本文件只断言
 * header / `%%` 指令 / text block / `V:` 声明四块，因此 `V:` 行之后不再有内容。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Voice } from '../../../../src/domain';
import { voiceId } from '../../../../src/domain';
import { loadJcx } from '../../../../src/formats/jcx';
import { serializeJcx } from '../../../../src/formats/jcx/serialize';
import {
  renderVoiceDeclaration,
  serializeCanonical,
} from '../../../../src/formats/jcx/serialize/canonical';

const FIXTURES_DIR = resolve(__dirname, '../../../fixtures/jcx');

function canonicalOf(source: string, magicHeader?: boolean): string {
  const { score } = loadJcx(source);
  return serializeCanonical(score, {
    mode: 'canonical',
    ...(magicHeader === undefined ? {} : { magicHeader }),
  }).text;
}

function fixtureSource(name: string): string {
  return readFileSync(resolve(FIXTURES_DIR, `${name}.jcx`), 'utf8');
}

/** canonical 末尾恒有换行，`split` 后去掉尾部空串，得到纯行数组。 */
function linesOf(text: string): string[] {
  expect(text.endsWith('\n')).toBe(true);
  return text.slice(0, -1).split('\n');
}

function canonicalLines(name: string, magicHeader?: boolean): string[] {
  return linesOf(canonicalOf(fixtureSource(name), magicHeader));
}

describe('canonical 骨架 —— header 行序与字段格式（方案 §3）', () => {
  it('minimal：%MUSE2 → X → T → M → L → K → V，冒号后恒一个空格', () => {
    expect(canonicalLines('minimal')).toEqual([
      '%MUSE2',
      'X: 1',
      'T: Test Piece One',
      'M: 4/4',
      'L: 1/4',
      'K: C',
      'V:1',
    ]);
  });

  it('magicHeader:false 时不写 %MUSE2（拍板 A）', () => {
    const lines = canonicalLines('minimal', false);
    expect(lines[0]).toBe('X: 1');
    expect(lines).not.toContain('%MUSE2');
  });

  it('角色序：源文件字段乱序时按 X→T→C→I→M→L→Q→unknown→K 重排（拍板 B）', () => {
    expect(canonicalLines('canonical-header-roles').slice(0, 10)).toEqual([
      '%MUSE2',
      'X: 7',
      'T: Roles Sample',
      'C: Composer One',
      'C: Composer Two',
      'I: Note One',
      'M: 3/4',
      'L: 1/8',
      'Q: 1/4=88',
      'S: source line',
    ]);
  });

  it('重复 T:/C: 按数组顺序各占一行，不拼接（spec §8.12）', () => {
    expect(canonicalLines('duplicate-fields')).toEqual([
      '%MUSE2',
      'X: 1',
      'T: First Title',
      'T: Second Title',
      'C: First Composer',
      'C: Second Composer',
      'M: 4/4',
      'L: 1/4',
      'K: C',
      'V:1',
    ]);
  });

  it('M: 写 meter.raw：M:C 这种 raw 分支不被换算成分数', () => {
    expect(canonicalLines('meter-common-time')).toContain('M: C');
  });

  it('K: 写 key.raw：行内 % 后的文本属于 raw，不当注释丢掉', () => {
    expect(canonicalLines('inline-percent')).toContain('K: G % 1 sharps');
  });

  it('覆盖型字段只写最终值；ignoredFields（body 区非法字段）不进 header 区', () => {
    const source = fixtureSource('header-override');
    const { score } = loadJcx(source);
    // 该 fixture 的第二条 K:G 落在 body 区，属 ignoredFields（spec §8.13）。
    expect(score.ignoredFields.map((field) => `${field.name}:${field.rawValue}`)).toEqual(['K:G']);

    const lines = linesOf(serializeCanonical(score, { mode: 'canonical' }).text);
    expect(lines).toEqual([
      '%MUSE2',
      'X: 1',
      'T: Header Override Sample',
      'M: 6/8',
      'L: 1/8',
      'Q: 1/4=96',
      'K: C',
      'V:1',
    ]);
    // ignoredFields 写在 header 区会被 re-parse 当成正式字段并改写语义，
    // 因此 T3 完全不输出它们，交由 T4 在 body 区重放。
    expect(lines.filter((line) => line.startsWith('K:'))).toEqual(['K: C']);
  });

  it('unknownFields 按数组顺序写在 header 区尾、K: 之前（拍板 G）', () => {
    expect(canonicalLines('unknown-field')).toEqual([
      '%MUSE2',
      'X: 1',
      'T: Unknown Field Sample',
      'M: 4/4',
      'L: 1/4',
      'S: some source note',
      'Z: some transcriber note',
      'K: C',
      'V:1',
    ]);
  });

  it('值两端空白去除、内部原样（拍板 D）', () => {
    const lines = linesOf(canonicalOf('%MUSE2\nX:1\nT:   Spaced   Title   \nK:C\nV:1\n'));
    expect(lines).toContain('T: Spaced   Title');
  });
});

describe('canonical 骨架 —— %% 指令与 text block（决策 9、10）', () => {
  it('%% 后空白被规范化：`%% continueall` / `%%\\tindent` → `%%name value`', () => {
    const lines = canonicalLines('directive-spaced');
    expect(lines.slice(-3)).toEqual(['%%continueall yes', '%%indent 2.5cm', 'V:1']);
  });

  it('指令写在 K: 之后、V: 之前，且不因 showFinger 额外生成指令行', () => {
    const source = fixtureSource('showfinger-variants');
    const { score } = loadJcx(source);
    expect(score.showFinger).toBe(false);

    const lines = linesOf(serializeCanonical(score, { mode: 'canonical' }).text);
    expect(lines.filter((line) => line.startsWith('%%'))).toEqual([
      '%%showfinger 1',
      '%%showfinger yes',
      '%%showfinger true',
      '%%showfinger 0',
      '%%showfinger maybe',
    ]);
    expect(lines.indexOf('%%showfinger 1')).toBeGreaterThan(lines.indexOf('K: C'));
    expect(lines.at(-1)).toBe('V:1');
  });

  it('text block：begintext + 原样内容行（含前导空白）+ endtext', () => {
    const lines = canonicalLines('text-block');
    expect(lines.slice(-6)).toEqual([
      '%%begintext',
      '      first text line',
      '                  % not a comment here',
      '                  T: not a field here',
      '%%endtext',
      'V:1',
    ]);
  });

  it('未闭合 text block 不补 %%endtext（决策 9 / 拍板 M）', () => {
    const source = fixtureSource('text-block-unclosed');
    const { score } = loadJcx(source);
    expect(score.textBlocks[0]?.closed).toBe(false);

    const lines = linesOf(serializeCanonical(score, { mode: 'canonical' }).text);
    expect(lines.slice(-3)).toEqual(['%%begintext', '  tail note line', 'V:1']);
    expect(lines).not.toContain('%%endtext');
  });
});

describe('canonical 骨架 —— V: 声明行（拍板 C / F）', () => {
  it('声部 id 用声明序号：v1 → V:1、v2 → V:2', () => {
    const lines = canonicalLines('voice-quoted-name');
    expect(lines.slice(-2)).toEqual(['V:1 name="a b"', 'V:2 name=伴奏']);
  });

  it('volumn=46 → vol=46、instrument=24 → ins=24；play=1 保持原拼写在尾部', () => {
    expect(canonicalLines('voice-alias-new').at(-1)).toBe('V:1 ins=24 vol=46 play=1');
  });

  it('短别名 ins=/vol= 原样往返（不写 UNVERIFIED 的 volume=）', () => {
    const line = canonicalLines('voice-alias-old').at(-1);
    expect(line).toBe('V:1 ins=24 vol=40');
    expect(line).not.toContain('volume=');
    expect(line).not.toContain('volumn=');
  });

  it('属性顺序固定为 name style clef ins vol bracket…，与源顺序无关', () => {
    const lines = canonicalLines('canonical-header-roles');
    expect(lines.slice(-2)).toEqual([
      'V:1 name=Guitar style=tab clef=standardtab ins=24 vol=40 bracket=2',
      'V:2 name="Lead Line" play=1',
    ]);
  });

  it('含空白的值加双引号，不含空白的值（含非 ASCII）不加', () => {
    const lines = linesOf(canonicalOf('%MUSE2\nX:1\nK:C\nV:1 name=伴奏 sname="a b"\n'));
    expect(lines.at(-1)).toBe('V:1 name=伴奏 sname="a b"');
  });

  it('值同时含空白与双引号时原样输出并发 warning（grammar 无 escape）', () => {
    // 这种值**解析不出来**（引号值取到下一个 `"` 为止、无引号值取到空白为止，
    // 两者都不可能同时含空白与 `"`），只能由编辑器等上游直接构造 Domain 产生，
    // 所以这一条不走 loadJcx，而是直接调 renderVoiceDeclaration。
    const voice: Voice = {
      id: voiceId(1),
      name: 'a "b" c',
      unknownAttributes: [],
      events: [],
      ties: [],
      slurs: [],
      tuplets: [],
      tabRelations: [],
      brokenRhythms: [],
      unitLengthChanges: [],
      lyricLines: [],
      origins: ['lines[0]'],
    };
    const rendered = renderVoiceDeclaration(voice);

    expect(rendered.line).toBe('V:1 name=a "b" c');
    expect(rendered.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'jcx.serialize.voice-value-unencodable',
    ]);
    expect(rendered.diagnostics[0]?.path).toBe('lines[0]');
  });

  it('值含双引号但不含空白时不加引号（不加才能原样回读）', () => {
    const voice: Voice = {
      id: voiceId(2),
      sname: 'a"b',
      unknownAttributes: [],
      events: [],
      ties: [],
      slurs: [],
      tuplets: [],
      tabRelations: [],
      brokenRhythms: [],
      unitLengthChanges: [],
      lyricLines: [],
      origins: [],
    };
    const rendered = renderVoiceDeclaration(voice);

    expect(rendered.line).toBe('V:2 sname=a"b');
    expect(rendered.diagnostics).toEqual([]);
  });
});

describe('canonical 骨架 —— 输出形态与幂等', () => {
  it('恒 UTF-8 / LF / 末尾换行，且 bytes 与 text 一致', () => {
    const { score } = loadJcx(fixtureSource('minimal'));
    const result = serializeCanonical(score, { mode: 'canonical' });
    expect(result.encoding).toBe('utf-8');
    expect(result.text).not.toContain('\r');
    expect(result.text.endsWith('\n')).toBe(true);
    expect(result.bytes).toEqual(new TextEncoder().encode(result.text));
    expect(result.diagnostics).toEqual([]);
  });

  it('公开入口 serializeJcx 在 T5 接线前拒绝 canonical（不返回无 body 的文件）', () => {
    const { score } = loadJcx(fixtureSource('minimal'));
    expect(() => serializeJcx(score, { mode: 'canonical' })).toThrow(
      'canonical: unavailable until M1.7 T5 (body and lyrics not yet serialised)',
    );
  });

  it('header 骨架幂等：canonical(parse(canonical(x))) === canonical(x)', () => {
    for (const name of ['minimal', 'canonical-header-roles', 'unknown-field', 'text-block']) {
      const once = canonicalOf(fixtureSource(name));
      expect(canonicalOf(once)).toBe(once);
    }
  });
});
