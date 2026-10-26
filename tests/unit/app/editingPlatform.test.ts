/**
 * M3 T3c：源码编辑平台门控（`src/renderer/app/editor/editingPlatform.ts`；Gate v2 §4，Q9-A）。
 */

import { describe, expect, it } from 'vitest';

import { SOURCE_EDITING_ENABLED, sourceEditingEnabledOn, sourceEditingPlatform } from '../../../src/renderer/app/editor/editingPlatform';

describe('editingPlatform —— 平台提示映射', () => {
  it.each([
    ['macOS', 'macos'],
    ['MacIntel', 'macos'],
    ['  macos  ', 'macos'],
    ['Windows', 'windows'],
    ['Win32', 'windows'],
    ['Linux', 'linux'],
    ['Linux x86_64', 'linux'],
    ['Chrome OS', 'unknown'],
    ['iOS', 'unknown'],
    ['iPhone', 'unknown'],
    ['Android', 'unknown'],
    ['', 'unknown'],
    ['Unknown', 'unknown'],
    ['Macintosh-ish', 'unknown'],
  ])('%s → %s', (hint, expected) => {
    expect(sourceEditingPlatform(hint)).toBe(expected);
  });

  it('null / undefined → unknown', () => {
    expect(sourceEditingPlatform(null)).toBe('unknown');
    expect(sourceEditingPlatform(undefined)).toBe('unknown');
  });
});

describe('editingPlatform —— 开关表', () => {
  it('恰为 macOS 开放，Windows / Linux / 未知只读；表被冻结', () => {
    expect(SOURCE_EDITING_ENABLED).toEqual({ macos: true, windows: false, linux: false, unknown: false });
    expect(Object.isFrozen(SOURCE_EDITING_ENABLED)).toBe(true);
    expect(sourceEditingEnabledOn('macos')).toBe(true);
    expect(sourceEditingEnabledOn('windows')).toBe(false);
    expect(sourceEditingEnabledOn('linux')).toBe(false);
    expect(sourceEditingEnabledOn('unknown')).toBe(false);
  });
});
