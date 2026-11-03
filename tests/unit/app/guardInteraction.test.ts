/**
 * M3 T4 B4 UI 定点修复：替换守卫面板的键盘与焦点规则（`src/renderer/app/guard/guardInteraction.ts`；B4 方案 r0.2 §2 G-M5 / G-M8）。
 * 守卫是非模态面板：这里只验证 Esc 与焦点归还的判定；并发文件操作的拒绝由准入租约负责（不在本文件）。
 */

import { describe, expect, it } from 'vitest';

import { askFocusAction, guardKeyAction, shouldRestoreFocus } from '../../../src/renderer/app/guard/guardInteraction';
import type { GuardFocusFacts, GuardKeyFacts } from '../../../src/renderer/app/guard/guardInteraction';

const ESC: GuardKeyFacts = { key: 'Escape', isComposing: false, keyCode: 27, defaultPrevented: false };

describe('guardKeyAction —— G-M5 Esc', () => {
  it('(a) 询问阶段的 Esc 等同取消', () => {
    expect(guardKeyAction('asking', ESC)).toBe('cancel');
  });

  it('(b) saving 阶段与 idle 的 Esc 不处理（不取消进行中的保存）', () => {
    expect(guardKeyAction('saving', ESC)).toBeNull();
    expect(guardKeyAction('idle', ESC)).toBeNull();
  });

  it('(c) 输入法组字中的 Esc 留给输入法：isComposing 或 keyCode 229 都不取消', () => {
    expect(guardKeyAction('asking', { ...ESC, isComposing: true })).toBeNull();
    expect(guardKeyAction('asking', { ...ESC, keyCode: 229 })).toBeNull();
    expect(guardKeyAction('asking', { ...ESC, isComposing: true, keyCode: 229 })).toBeNull();
  });

  it('(d) 已被其它处理器消费的 Esc 不处理', () => {
    expect(guardKeyAction('asking', { ...ESC, defaultPrevented: true })).toBeNull();
  });

  it('(e) 其它按键（含 Enter、Tab、字母与 Esc 的旧名）一律不处理', () => {
    for (const key of ['Enter', 'Tab', ' ', 'a', 'Esc', 'escape', 'Backspace']) {
      expect(guardKeyAction('asking', { ...ESC, key }), key).toBeNull();
    }
  });
});

describe('askFocusAction —— G-M4 进入询问时的焦点', () => {
  it('面板新出现（idle → asking）：记下原焦点并聚焦「取消」，不论当前焦点在哪里', () => {
    for (const facts of [{ focusInPanel: false, focusOnBody: false }, { focusInPanel: false, focusOnBody: true }, { focusInPanel: true, focusOnBody: false }]) {
      expect(askFocusAction('idle', facts)).toBe('initial');
    }
  });

  it('保存后仍未 clean 重新询问（saving → asking）：用户在编辑区时不抢焦点（G6）', () => {
    expect(askFocusAction('saving', { focusInPanel: false, focusOnBody: false })).toBe('keep');
  });

  it('重新询问且焦点在 body 或面板内：放回「取消」，但不重新记录原焦点', () => {
    expect(askFocusAction('saving', { focusInPanel: false, focusOnBody: true })).toBe('refocus');
    expect(askFocusAction('saving', { focusInPanel: true, focusOnBody: false })).toBe('refocus');
    expect(askFocusAction('asking', { focusInPanel: true, focusOnBody: false })).toBe('refocus');
  });
});

const IN_PANEL: GuardFocusFacts = { openerAvailable: true, focusInPanel: true, focusOnBody: false };

describe('shouldRestoreFocus —— G-M8 焦点归还', () => {
  it('(a) 以取消结束、原焦点仍在：焦点在面板内或已落回 body 时归还', () => {
    expect(shouldRestoreFocus('cancel', IN_PANEL)).toBe(true);
    expect(shouldRestoreFocus('cancel', { ...IN_PANEL, focusInPanel: false, focusOnBody: true })).toBe(true);
  });

  it('(b) 用户已把焦点移到面板之外（如回到编辑区）：不覆盖', () => {
    expect(shouldRestoreFocus('cancel', { ...IN_PANEL, focusInPanel: false, focusOnBody: false })).toBe(false);
  });

  it('原焦点已不在文档中（或原本就是 body）：不归还', () => {
    expect(shouldRestoreFocus('cancel', { ...IN_PANEL, openerAvailable: false })).toBe(false);
  });

  it('(c)(d) 不是以取消结束（保存 / 不保存 / 宿主消失）：不归还', () => {
    expect(shouldRestoreFocus('other', IN_PANEL)).toBe(false);
    expect(shouldRestoreFocus('other', { ...IN_PANEL, focusInPanel: false, focusOnBody: true })).toBe(false);
  });
});
