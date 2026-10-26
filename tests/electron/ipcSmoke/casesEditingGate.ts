/**
 * J 组：源码编辑的平台门控（M3 T3c；Preflight r1 §8；用户裁决 Q9-A）。
 *
 * `ui.edit-gate-` 前缀，各平台使用**真实** UA（不做任何覆盖）。smoke main 用 `process.platform` 算出期望，与页面上的门控结果对照：
 * - 平台识别：页面 `navigator.userAgentData.platform` 必须是该平台的标准取值（识别漂移会让门控 fail closed，用例据此报失败）。
 * - macOS：源码面板可编辑、无只读说明。
 * - Windows / Linux：`readOnly`、有只读说明；聚焦后注入文字、粘贴、合成组字都不改变 view 与 sourceVersion；随后 Cmd/Ctrl+Z 只得到
 *   「没有可撤销的操作」（没有建立任何 History 事务）。
 * 这证明门控在该平台的真实运行时生效，**不是**该平台的输入法 / 菜单 / 窗口验收（G4-Windows / G4-Linux 另行实机进行）。
 */

import { clipboard } from 'electron';

import { classifyConsole, expectEqual, expectTrue, verdict } from './context';
import type { IsolatedCase } from './casesIsolated';
import { delay } from './harness';
import { cdp, editorWindow, focusSource, readEditor, undoKey, waitEditor } from './casesEditingInput';

const UA_PLATFORM: Readonly<Record<string, string>> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

const uiEditGatePlatform: IsolatedCase = {
  id: 'ui.edit-gate-platform',
  realDialog: false,
  run: async (ctx) => {
    const { window, consoleEntries, ready } = await editorWindow(ctx, false);
    const problems: string[] = [];
    expectTrue(problems, 'editor ready', ready);
    const initial = await readEditor(window);
    const editable = process.platform === 'darwin';
    expectEqual(problems, 'real UA platform hint', initial?.uaPlatform, UA_PLATFORM[process.platform] ?? null);
    expectEqual(problems, 'readOnly matches the frozen table', initial?.readOnly, !editable);
    expectEqual(problems, 'read-only note only where editing is closed', initial?.readOnlyNote, !editable);

    if (!editable) {
      const v0 = initial?.sourceVersion ?? 0;
      const original = initial?.value ?? '';
      await focusSource(window, 0);
      await window.win.webContents.insertText('x');
      clipboard.writeText('P');
      window.win.webContents.paste();
      await cdp(window.win, 'Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
      await cdp(window.win, 'Input.insertText', { text: '你' });
      await delay(500);
      const after = await readEditor(window);
      expectEqual(problems, 'gated: view and version unchanged', [after?.sourceVersion, after?.value], [v0, original]);
      undoKey(window);
      const undo = await waitEditor(window, (doc) => doc.notice === 'nothing-to-undo');
      expectTrue(problems, 'gated: no history transaction was created', undo !== null);
    }
    expectEqual(problems, 'unexpected console errors', classifyConsole(consoleEntries, []).unexpected, []);
    return verdict(problems, { platform: process.platform, editable });
  },
};

export const EDITING_GATE_CASES: readonly IsolatedCase[] = [uiEditGatePlatform];
