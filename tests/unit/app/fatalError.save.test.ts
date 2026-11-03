/**
 * M3 T4 B3a-2：根卸载后保存结果的非 React 出口（`fatalError.ts`，R12；B3 r0 §3.7）。
 *
 * 致命提示同时订阅 dirty 与保存视图：保存结果（成功 / 失败）实时追加在提示末尾；取消订阅同时解除两者。
 */

import { describe, expect, it } from 'vitest';

import { createFatalNotice, fatalNoticeText } from '../../../src/renderer/app/fatalError';

describe('fatalError —— 保存结果出口（R12）', () => {
  it('保存结果变化时实时更新；没有保存结果时与原文案相同；取消订阅解除两者', () => {
    const element = { textContent: null as string | null };
    let emitDirty: (dirty: boolean) => void = () => undefined;
    let emitSave: (text: string | null) => void = () => undefined;
    const off: string[] = [];
    const show = createFatalNotice({
      create: () => element,
      attach: () => undefined,
      subscribeDirty: (listener) => {
        emitDirty = listener;
        listener(true);
        return () => off.push('dirty');
      },
      subscribeSave: (listener) => {
        emitSave = listener;
        listener(null);
        return () => off.push('save');
      },
    });
    const stop = show();
    expect(element.textContent).toBe(fatalNoticeText(true));
    emitSave('已保存 a.jcx。');
    expect(element.textContent).toBe(`${fatalNoticeText(true)}保存：已保存 a.jcx。`);
    emitDirty(false);
    expect(element.textContent).toBe(`${fatalNoticeText(false)}保存：已保存 a.jcx。`);
    stop();
    expect(off.sort()).toEqual(['dirty', 'save']);
  });
});
