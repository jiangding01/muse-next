/**
 * M3 T4 B4 UI 定点修复：守卫面板的静态结构与布局约束（B4 方案 r0.2 §2 G-M1 / G-M3 / G-M6、§3 T2）。
 *
 * 不引入 jsdom（与 notation D10 一致）：结构用 `renderToStaticMarkup` 检查纯展示组件 `ReplacementGuardPanel`；真实 DOM 的
 * 焦点、Esc、可见性与重叠由 Electron smoke（`ui.guard-open-*`、`ui.save-layout`）在真实 Chromium 中验证。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ReplacementGuardPanel } from '../../../src/renderer/components/ReplacementGuardDialog';
import { REPO_ROOT } from '../editor/staticAnalysis';

const render = (phase: 'asking' | 'saving'): string => renderToStaticMarkup(createElement(ReplacementGuardPanel, { phase, onChoose: () => undefined }));
const buttons = (html: string): string[] => [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);

describe('ReplacementGuardPanel —— 非模态语义与按钮', () => {
  it('非模态 alertdialog：不声明 aria-modal="true"，问句经 labelledby / describedby 关联', () => {
    const html = render('asking');
    expect(html).toContain('role="alertdialog"');
    expect(html).not.toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="replacement-guard-title"');
    expect(html).toContain('aria-describedby="replacement-guard-message"');
    expect(html).toContain('id="replacement-guard-title"');
    expect(html).toContain('id="replacement-guard-message"');
    expect(html).toContain('当前文档有未保存的修改。打开其它文件之前，是否先保存？');
  });

  it('询问阶段三个按钮可用且选择齐全；saving 阶段三个按钮全部 disabled（G-M6）', () => {
    const asking = buttons(render('asking'));
    expect(asking.map((b) => /data-guard-choice="(\w+)"/.exec(b)?.[1])).toEqual(['save', 'discard', 'cancel']);
    expect(asking.filter((b) => b.includes('disabled'))).toEqual([]);
    const saving = buttons(render('saving'));
    expect(saving).toHaveLength(3);
    expect(saving.every((b) => b.includes('disabled'))).toBe(true);
    expect(render('saving')).toContain('data-guard-phase="saving"');
  });
});

describe('global.css —— app-shell 六行布局（G-M1：守卫、保存入口与保存提示不重叠、不错位）', () => {
  const css = readFileSync(join(REPO_ROOT, 'src/renderer/styles/global.css'), 'utf8');

  it('行模板为六行，主工作区在第 4 行（minmax(0, 1fr)）', () => {
    expect(css).toContain('.app-shell { height: 100%; display: grid; grid-template-rows: 64px auto auto minmax(0, 1fr) auto auto; overflow: hidden; }');
  });

  it('每个子元素固定 grid-row（条件渲染不会让后续元素错位）', () => {
    const rows = [...css.matchAll(/^\.app-shell > \.([\w-]+) \{ grid-row: (\d); \}$/gm)].map((m) => `${m[1] ?? ''}:${m[2] ?? ''}`);
    expect(rows).toEqual(['toolbar:1', 'save-entry:2', 'replacement-guard:3', 'app-grid:4', 'save-diagnostics:5', 'editor-status:6']);
  });

  it('守卫没有全屏遮罩（保留 G6：询问期间允许继续编辑）', () => {
    const guard = [...css.matchAll(/^\.replacement-guard[^{]*\{[^}]*\}/gm)].map((m) => m[0]).join('\n');
    expect(guard).not.toMatch(/position:\s*fixed|inset:\s*0|100vh|100vw/);
  });
});
