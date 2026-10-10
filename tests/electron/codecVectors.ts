/**
 * Electron runtime codec 向量（M3 T1a，`docs/M3_EDITOR_CORE_PLAN.md` §11.3–§11.6、§25.2）。
 *
 * 全部经 `src/main/document/*` 的 helper 判定（不是只测裸 decodeJcx），因此结论就是 main 打开文件时的真实行为。
 * 映射敏感向量（0x80、A6D9、FE59、FE61）只在这里断言：普通 Node 的 ICU 数据与 Electron 不同（§25.2）。
 */

import { decodeJcx, encodeJcx } from '../../src/formats/jcx/codec';
import type { JcxEncoding } from '../../src/formats/jcx/codec';
import { classifyDecodeFailure, classifyEncodingRoundTrip, decodeDocumentBytes } from '../../src/main/document/decodeDocument';
import type { DecodeFailureCode } from '../../src/shared/openContracts';
import { codePoints, expectSame, hex, verdict } from './probeHarness';
import type { Outcome, ProbeRecorder } from './probeHarness';

const FEFF = '﻿';
const b = (...values: number[]): Uint8Array => Uint8Array.from(values);

interface SuccessExpectation {
  readonly source: string;
  readonly writeEncoding: JcxEncoding;
  readonly byteBom: 'utf8' | 'none';
}

function expectDecoded(bytes: Uint8Array, expected: SuccessExpectation): Outcome {
  const result = decodeDocumentBytes(bytes);
  const problems: string[] = [];
  if (!result.ok) return verdict([`decode failed with ${result.code}`]);
  expectSame(problems, 'source', codePoints(result.source), codePoints(expected.source));
  expectSame(problems, 'writeEncoding', result.writeEncoding, expected.writeEncoding);
  expectSame(problems, 'byteBom', result.byteBom, expected.byteBom);
  expectSame(problems, 'encodingRoundTrip', result.encodingRoundTrip, 'exact');
  return verdict(problems);
}

function expectFailure(bytes: Uint8Array, code: DecodeFailureCode): Outcome {
  const result = decodeDocumentBytes(bytes);
  const problems: string[] = [];
  expectSame(problems, 'result', result, { ok: false, code });
  expectSame(problems, 'classify', classifyDecodeFailure(bytes), code);
  return verdict(problems, hex(bytes));
}

function errorName(body: () => unknown): string {
  try {
    body();
    return 'no-throw';
  } catch (error) {
    return error instanceof Error ? error.name : typeof error;
  }
}

const INVALID_GB18030: readonly (readonly number[])[] = [
  [0x41, 0x80, 0x41],
  [0x41, 0xff, 0x41],
  [0x41, 0x81, 0x30],
  [0x41, 0x81],
  [0x41, 0x81, 0x7f, 0x41],
  [0x84, 0x31, 0xa5, 0x30],
  [0xe3, 0x32, 0x9a, 0x36],
];

/** 只在 Electron ICU 下成立：这些双字节解为私用区码点且 encode 回去逐字节相同。 */
const MAPPING_SENSITIVE: readonly (readonly [string, number, number])[] = [
  ['A6D9', 0xa6, 0xd9],
  ['FE59', 0xfe, 0x59],
  ['FE61', 0xfe, 0x61],
];

const ROUND_TRIP_TEXTS: readonly (readonly [JcxEncoding, string])[] = [
  ['utf-8', 'X:1\nT:test\n'],
  ['utf-8', '中文歌词\r\nw: 一 二 三\n'],
  ['utf-8', `${FEFF}T:bom\n`],
  ['utf-8', '\u{1D11E} \u{1F3B5}'],
  ['gb18030', '中文'],
  ['gb18030', `${FEFF}中`],
  ['gb18030', 'ＡＢ 全角'],
  ['gb18030', '\u{1F600}'],
  ['gb18030', ''],
];

export async function runCodecVectors(recorder: ProbeRecorder): Promise<void> {
  await recorder.run('codec.utf8', () => expectDecoded(new TextEncoder().encode('T:中文\n'), { source: 'T:中文\n', writeEncoding: 'utf-8', byteBom: 'none' }));

  await recorder.run('codec.utf8-bom', () => {
    const outcome = expectDecoded(b(0xef, 0xbb, 0xbf, 0x41), { source: `${FEFF}A`, writeEncoding: 'utf-8', byteBom: 'utf8' });
    const problems = outcome.pass ? [] : [outcome.detail ?? 'failed'];
    expectSame(problems, 'encode', hex(encodeJcx(`${FEFF}A`, 'utf-8').bytes), 'EF BB BF 41');
    return verdict(problems);
  });

  await recorder.run('codec.gb18030-common', () => expectDecoded(b(0xd6, 0xd0, 0xce, 0xc4), { source: '中文', writeEncoding: 'gb18030', byteBom: 'none' }));

  await recorder.run('codec.gb18030-leading-feff', () =>
    expectDecoded(b(0x84, 0x31, 0x95, 0x33, 0xd6, 0xd0), { source: `${FEFF}中`, writeEncoding: 'gb18030', byteBom: 'none' }),
  );

  for (const [label, lead, trail] of MAPPING_SENSITIVE) {
    await recorder.run(`codec.mapping-${label}`, () => {
      const bytes = b(0x41, lead, trail, 0x41);
      const result = decodeDocumentBytes(bytes);
      if (!result.ok) return verdict([`decode failed with ${result.code}`]);
      const problems: string[] = [];
      expectSame(problems, 'writeEncoding', result.writeEncoding, 'gb18030');
      expectSame(problems, 'encodingRoundTrip', result.encodingRoundTrip, 'exact');
      expectSame(problems, 'length', Array.from(result.source).length, 3);
      return verdict(problems, `decoded ${codePoints(result.source)}`);
    });
  }

  await recorder.run('codec.utf16-le', () => expectFailure(b(0xff, 0xfe, 0x41, 0x00), 'decode-utf16-unsupported'));
  await recorder.run('codec.utf16-be', () => expectFailure(b(0xfe, 0xff, 0x00, 0x41), 'decode-utf16-unsupported'));
  await recorder.run('codec.bom-invalid-utf8', () => {
    const bytes = b(0xef, 0xbb, 0xbf, 0xc3, 0x28);
    const outcome = expectFailure(bytes, 'decode-invalid-utf8');
    const problems = outcome.pass ? [] : [outcome.detail ?? 'failed'];
    // 记录事实：生产 decodeJcx 在此分支抛未包装的原生 TypeError。
    expectSame(problems, 'raw error', errorName(() => decodeJcx(bytes)), 'TypeError');
    return verdict(problems);
  });

  for (const values of INVALID_GB18030) {
    const bytes = Uint8Array.from(values);
    await recorder.run(`codec.invalid-gb18030 ${hex(bytes)}`, () => expectFailure(bytes, 'decode-invalid-gb18030'));
  }

  for (const [encoding, text] of ROUND_TRIP_TEXTS) {
    await recorder.run(`codec.encode-decode ${encoding} ${codePoints(text).slice(0, 40)}`, () => {
      const bytes = encodeJcx(text, encoding).bytes;
      const result = decodeDocumentBytes(bytes);
      const problems: string[] = [];
      if (!result.ok) return verdict([`decode failed with ${result.code} for ${hex(bytes)}`]);
      expectSame(problems, 'text', codePoints(result.source), codePoints(text));
      expectSame(problems, 'roundTrip', classifyEncodingRoundTrip(text, encoding, bytes), 'exact');
      return verdict(problems, `detected ${result.writeEncoding}`);
    });
  }

  await recorder.run('codec.gb18030-to-ascii', () => {
    const bytes = encodeJcx('abc', 'gb18030').bytes;
    const result = decodeDocumentBytes(bytes);
    const problems: string[] = [];
    expectSame(problems, 'bytes', hex(bytes), '61 62 63');
    expectSame(problems, 'decoded', result.ok && { source: result.source, writeEncoding: result.writeEncoding }, { source: 'abc', writeEncoding: 'utf-8' });
    return verdict(problems);
  });

  await recorder.run('codec.gb18030-bytes-valid-utf8', () => {
    const result = decodeDocumentBytes(b(0xd2, 0xbb));
    const problems: string[] = [];
    if (!result.ok) return verdict([`decode failed with ${result.code}`]);
    expectSame(problems, 'writeEncoding', result.writeEncoding, 'utf-8');
    if (result.source === '一') problems.push('source unexpectedly equals the GB18030 reading');
    // Save 的自解码校验（T4）负责拒绝此类候选字节；这里只记录事实。
    return verdict(problems, `decoded ${codePoints(result.source)}`);
  });

  await recorder.run('codec.candidate-starts-with-utf8-bom', () => {
    const text = new TextDecoder('gb18030', { fatal: true, ignoreBOM: true }).decode(b(0xef, 0xbb, 0xbf, 0xd0));
    const candidate = encodeJcx(text, 'gb18030').bytes;
    const problems: string[] = [];
    expectSame(problems, 'candidate', hex(candidate), 'EF BB BF D0');
    expectSame(problems, 'raw error', errorName(() => decodeJcx(candidate)), 'TypeError');
    expectSame(problems, 'decode', decodeDocumentBytes(candidate), { ok: false, code: 'decode-invalid-utf8' });
    return verdict(problems, `text ${codePoints(text)}`);
  });

  await recorder.run('codec.lone-surrogate-gb18030', () => {
    const problems: string[] = [];
    expectSame(problems, 'encode error', errorName(() => encodeJcx('a\uD800b', 'gb18030')), 'JcxEncodingError');
    expectSame(problems, 'roundTrip', classifyEncodingRoundTrip('a\uD800b', 'gb18030', b(0x61, 0x3f, 0x62)), 'unsafe');
    return verdict(problems);
  });
}
