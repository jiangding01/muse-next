/**
 * T7.2 —— `canonicalKeySpelling` / `keyHasExtraText`（`src/notation/layout/keySpelling.ts`）。
 *
 * 只测字符串层面的判断：`KeySignature` 直接按 Domain 形状构造（`parseKey` 的产出形态
 * 见 `src/formats/jcx/parse/keyMeter.ts`），不经过 `loadJcx`——本文件测的是「raw 里
 * 除了音名与升降记号还有没有别的东西」，与解析路径无关。
 */
import { describe, expect, it } from 'vitest';

import type { KeySignature } from '../../../src/domain';
import { canonicalKeySpelling, keyHasExtraText } from '../../../src/notation/layout/keySpelling';

function key(raw: string, tonic?: string, alter?: number): KeySignature {
  if (tonic === undefined) return { raw };
  return alter === undefined ? { raw, tonic } : { raw, tonic, alter };
}

describe('canonicalKeySpelling —— 音名 + 升降记号', () => {
  it('alter 为 0 / undefined 时就是主音本身', () => {
    expect(canonicalKeySpelling(key('C', 'C', 0))).toBe('C');
    expect(canonicalKeySpelling(key('C', 'C'))).toBe('C');
  });

  it('alter ±1 拼出 # / b', () => {
    expect(canonicalKeySpelling(key('Eb', 'E', -1))).toBe('Eb');
    expect(canonicalKeySpelling(key('F#', 'F', 1))).toBe('F#');
  });

  it('tonic 缺失时没有规范拼写', () => {
    expect(canonicalKeySpelling(key('clef=bass'))).toBeUndefined();
  });

  it('alter 不是 -1 / 0 / +1 时没有规范拼写（**绝不静默当成自然音**）', () => {
    expect(canonicalKeySpelling(key('E', 'E', -2))).toBeUndefined();
    expect(canonicalKeySpelling(key('F', 'F', 2))).toBeUndefined();
  });
});

describe('keyHasExtraText —— raw 里还有没有别的东西', () => {
  it('raw 恰好等于规范拼写时为假（两端空白不算）', () => {
    expect(keyHasExtraText(key('Eb', 'E', -1))).toBe(false);
    expect(keyHasExtraText(key('  C  ', 'C', 0))).toBe(false);
  });

  it('mode 文本 / clef 文本 / 行内 % 注释都算「还有别的东西」', () => {
    expect(keyHasExtraText(key('Dm', 'D', 0))).toBe(true);
    expect(keyHasExtraText(key('Eb major', 'E', -1))).toBe(true);
    expect(keyHasExtraText(key('C clef=bass', 'C', 0))).toBe(true);
    expect(keyHasExtraText(key('G % 1 sharps', 'G', 0))).toBe(true);
  });

  it('规范拼写不存在时一律为真（tonic 缺失 / alter 不认识）', () => {
    expect(keyHasExtraText(key('none'))).toBe(true);
    expect(keyHasExtraText(key('E', 'E', -2))).toBe(true);
  });

  it('不做大小写归一、不折叠内部空白——那些都是作者写下的字符', () => {
    expect(keyHasExtraText(key('eb', 'E', -1))).toBe(true);
    expect(keyHasExtraText(key('E  b', 'E', -1))).toBe(true);
  });
});
