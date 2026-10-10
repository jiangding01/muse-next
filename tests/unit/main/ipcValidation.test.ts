/**
 * M3 T1b-1：sender 快照与 IPC payload 的纯校验（用户裁决 6）。
 *
 * 重点是对抗性输入：前缀相同但来源不同的 URL、非主 frame、已销毁 / 非登记窗口、畸形或多余字段的 payload。
 */

import { describe, expect, it } from 'vitest';

import { matchesPageIdentity, parseActivationTicket, parseOpenRequest, validateSender } from '../../../src/main/open/ipcValidation';
import type { PageIdentity, SenderSnapshot } from '../../../src/main/open/ipcValidation';

const DEV: PageIdentity = { kind: 'dev-server', origin: 'http://localhost:5173' };
const FILE: PageIdentity = { kind: 'file', url: 'file:///app/.vite/renderer/main_window/index.html' };

const good: SenderSnapshot = {
  webContentsId: 7,
  destroyed: false,
  isRegisteredWindow: true,
  isMainFrame: true,
  frameUrl: 'file:///app/.vite/renderer/main_window/index.html',
};

describe('matchesPageIdentity —— 精确匹配，不做前缀判定', () => {
  it.each([
    ['http://localhost:5173/', DEV, true],
    ['http://localhost:5173/index.html', DEV, true],
    ['http://localhost:5173/index.html#/score', DEV, true],
    ['http://localhost:5173.evil.test/', DEV, false],
    ['http://localhost:51730/', DEV, false],
    ['https://localhost:5173/', DEV, false],
    ['http://127.0.0.1:5173/', DEV, false],
    ['http://localhost:5173/other.html', DEV, false],
    ['http://localhost:5173/?x=1', DEV, false],
    ['http://user:pw@localhost:5173/', DEV, false],
    ['file:///app/.vite/renderer/main_window/index.html', FILE, true],
    ['file:///app/.vite/renderer/main_window/index.html#top', FILE, true],
    ['file:///app/.vite/renderer/main_window/index.html.evil', FILE, false],
    ['file:///app/.vite/renderer/main_window/other.html', FILE, false],
    ['file:///app/.vite/renderer/main_window/index.html?x', FILE, false],
    ['file://remote-host/app/.vite/renderer/main_window/index.html', FILE, false],
    ['http://localhost:5173/', FILE, false],
    ['file:///app/.vite/renderer/main_window/index.html', DEV, false],
    ['not a url', FILE, false],
    ['', DEV, false],
  ] as const)('%s vs %j → %s', (url, identity, expected) => {
    expect(matchesPageIdentity(url, identity)).toBe(expected);
  });

  it('身份本身不合法（dev 非 http(s)、file 非 file:）时一律拒绝', () => {
    expect(matchesPageIdentity('file:///x', { kind: 'dev-server', origin: 'file:///x' })).toBe(false);
    expect(matchesPageIdentity('http://localhost:5173/', { kind: 'file', url: 'http://localhost:5173/' })).toBe(false);
    expect(matchesPageIdentity('http://localhost:5173/', { kind: 'dev-server', origin: 'garbage' })).toBe(false);
    expect(matchesPageIdentity('http://localhost:5173/', { kind: 'dev-server', origin: 'http://localhost:5173/app/?q' })).toBe(false);
    expect(matchesPageIdentity('http://localhost:5173/', { kind: 'dev-server', origin: 'http://localhost:5173/' })).toBe(false);
  });
});

describe('validateSender', () => {
  it('应用窗口主 frame 上的应用页面 → ok，owner 为 webContents id', () => {
    expect(validateSender(good, FILE)).toEqual({ ok: true, ownerId: 7 });
  });

  it.each([
    ['已销毁', { ...good, destroyed: true }],
    ['非登记窗口（其它 BrowserWindow / 无窗口的 webContents）', { ...good, isRegisteredWindow: false }],
    ['非主 frame', { ...good, isMainFrame: false }],
    ['senderFrame 已不存在（导航后）', { ...good, frameUrl: null }],
    ['页面来源不符', { ...good, frameUrl: 'file:///elsewhere/index.html' }],
    ['webContents id 非法', { ...good, webContentsId: -1 }],
    ['webContents id 非整数', { ...good, webContentsId: 1.5 }],
    ['页面 URL 为空串', { ...good, frameUrl: '' }],
  ] as const)('%s → 拒绝', (_label, snapshot) => {
    expect(validateSender(snapshot, FILE)).toEqual({ ok: false });
  });

  it('拒绝结果不携带任何快照内容', () => {
    expect(Object.keys(validateSender({ ...good, isMainFrame: false }, FILE))).toEqual(['ok']);
  });
});

describe('parseOpenRequest —— 恰为 { intent: "dialog" }', () => {
  it('合法输入', () => {
    expect(parseOpenRequest({ intent: 'dialog' })).toEqual({ intent: 'dialog' });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['字符串', 'dialog'],
    ['数组', ['dialog']],
    ['空对象', {}],
    ['其它 intent', { intent: 'path' }],
    ['多余字段（夹带路径）', { intent: 'dialog', path: '/etc/passwd' }],
    ['非普通对象原型', Object.assign(Object.create({ inherited: true }), { intent: 'dialog' })],
    ['Symbol 键', { intent: 'dialog', [Symbol('x')]: 1 }],
    ['不可枚举的多余键', Object.defineProperty({ intent: 'dialog' }, 'path', { value: '/x', enumerable: false })],
    ['读取时抛错的 getter（异常不外传）', Object.defineProperty({}, 'intent', { enumerable: true, get: () => { throw new Error('boom'); } })],
  ] as const)('%s → null', (_label, payload) => {
    expect(parseOpenRequest(payload)).toBeNull();
  });
});

describe('parseActivationTicket —— 恰为 { capabilityId, documentId }', () => {
  it('合法输入（UUID 形状）', () => {
    const ticket = { capabilityId: '6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d', documentId: 3 };
    expect(parseActivationTicket(ticket)).toEqual(ticket);
  });

  it.each([
    ['缺 documentId', { capabilityId: 'abc' }],
    ['多余字段', { capabilityId: 'abc', documentId: 1, path: '/x' }],
    ['capabilityId 非字符串', { capabilityId: 1, documentId: 1 }],
    ['capabilityId 为空', { capabilityId: '', documentId: 1 }],
    ['capabilityId 含路径字符', { capabilityId: '../etc', documentId: 1 }],
    ['capabilityId 过长', { capabilityId: 'a'.repeat(65), documentId: 1 }],
    ['documentId 为 0（demo）', { capabilityId: 'abc', documentId: 0 }],
    ['documentId 为负', { capabilityId: 'abc', documentId: -1 }],
    ['documentId 非整数', { capabilityId: 'abc', documentId: 1.5 }],
    ['documentId 超出安全整数', { capabilityId: 'abc', documentId: Number.MAX_SAFE_INTEGER + 1 }],
    ['documentId 为字符串', { capabilityId: 'abc', documentId: '1' }],
    ['null', null],
  ] as const)('%s → null', (_label, payload) => {
    expect(parseActivationTicket(payload)).toBeNull();
  });
});
