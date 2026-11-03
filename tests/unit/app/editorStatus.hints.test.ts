/**
 * M3 T4 B3b：状态栏的文件状态提示（`editorStatus.fileHints`；r0 §2.3 b8）——未命名 / unsafe / 授权未确认。
 */

import { describe, expect, it } from 'vitest';

import { fileHints, fileHintText } from '../../../src/renderer/app/editor/editorStatus';
import { createDemoSession } from '../../../src/renderer/app/editor/sessionFactory';

describe('editorStatus.fileHints', () => {
  it('未命名、unsafe、unverified 各自独立给出；有文件、exact、trusted 时为空', () => {
    const demo = createDemoSession();
    expect(fileHints(demo, 'none')).toEqual(['unnamed']);
    const file = { ...demo, file: { capability: { id: 'c' }, displayName: 'a.jcx', displayPath: '/a.jcx' } };
    expect(fileHints(file, 'trusted')).toEqual([]);
    expect(fileHints({ ...file, encodingRoundTrip: 'unsafe' }, 'unverified')).toEqual(['unsafe', 'unverified']);
    for (const hint of ['unnamed', 'unsafe', 'unverified'] as const) expect(fileHintText(hint).length).toBeGreaterThan(0);
    expect(new Set((['unnamed', 'unsafe', 'unverified'] as const).map(fileHintText)).size).toBe(3);
  });
});
