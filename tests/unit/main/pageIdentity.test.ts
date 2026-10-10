/**
 * M3 T1b-2a：应用页面的加载 URL 与可信页面身份（`src/main/ipc/pageIdentity.ts`）。
 *
 * 钉死三件事：加载 URL 与身份来自同一个字符串；`pathToFileURL` 对空格 / 中文 / 字面 `%` / `#` / `?` 的编码与大小写保留；
 * Windows 只规范盘符。每个用例都把结果交给 T1b-1 已封板的 `matchesPageIdentity` 复核（不放宽匹配器）。
 * Chromium 在 Windows 上的真实 frame URL 由 T1b-2b 的窗口 smoke 最终确认。
 */

import { describe, expect, it } from 'vitest';

import { fileIndexUrl, resolvePageEntry, uppercaseDriveLetter } from '../../../src/main/ipc/pageIdentity';
import { matchesPageIdentity } from '../../../src/main/open/ipcValidation';

describe('fileIndexUrl —— POSIX 路径编码', () => {
  it.each([
    ['/Applications/Muse Next.app/Contents/Resources/index.html', 'file:///Applications/Muse%20Next.app/Contents/Resources/index.html'],
    ['/opt/中文 目录/index.html', 'file:///opt/%E4%B8%AD%E6%96%87%20%E7%9B%AE%E5%BD%95/index.html'],
    ['/opt/percent %25 and %/index.html', 'file:///opt/percent%20%2525%20and%20%25/index.html'],
    ['/opt/hash#and?query/index.html', 'file:///opt/hash%23and%3Fquery/index.html'],
    ['/opt/MixedCase/Index.HTML', 'file:///opt/MixedCase/Index.HTML'],
  ])('%s', (path, expected) => {
    const url = fileIndexUrl(path, 'darwin');
    expect(url).toBe(expected);
    expect(matchesPageIdentity(url, { kind: 'file', url })).toBe(true);
  });
});

describe('fileIndexUrl —— Windows（只规范盘符）', () => {
  it.each([
    ['C:\\Program Files\\Muse Next\\resources\\index.html', 'file:///C:/Program%20Files/Muse%20Next/resources/index.html'],
    ['c:\\Users\\用户\\AppData\\index.html', 'file:///C:/Users/%E7%94%A8%E6%88%B7/AppData/index.html'],
    ['d:\\Mixed Case\\%25\\Index.html', 'file:///D:/Mixed%20Case/%2525/Index.html'],
    ['\\\\server\\share\\Muse\\index.html', 'file://server/share/Muse/index.html'],
  ])('%s', (path, expected) => {
    const url = fileIndexUrl(path, 'win32');
    expect(url).toBe(expected);
    expect(matchesPageIdentity(url, { kind: 'file', url })).toBe(true);
  });

  it('盘符之外的大小写不被折叠：身份与小写化后的 URL 不匹配', () => {
    const url = fileIndexUrl('C:\\Muse\\Index.html', 'win32');
    expect(matchesPageIdentity(url.toLowerCase(), { kind: 'file', url })).toBe(false);
  });

  it('uppercaseDriveLetter 只改 file:/// 后紧跟的盘符', () => {
    expect(uppercaseDriveLetter('file:///c:/a/b')).toBe('file:///C:/a/b');
    expect(uppercaseDriveLetter('file:///C:/a/b')).toBe('file:///C:/a/b');
    expect(uppercaseDriveLetter('file:///opt/c:/x')).toBe('file:///opt/c:/x');
    expect(uppercaseDriveLetter('file://server/c:/x')).toBe('file://server/c:/x');
    expect(uppercaseDriveLetter('http://c:/x')).toBe('http://c:/x');
  });
});

describe('resolvePageEntry —— 可信入口只来自 main 配置', () => {
  it('生产：loadUrl 与身份 url 是同一个字符串', () => {
    const entry = resolvePageEntry({ devServerUrl: undefined, indexFilePath: '/opt/Muse Next/index.html', platform: 'linux' });
    expect(entry.identity).toEqual({ kind: 'file', url: entry.loadUrl });
    expect(entry.loadUrl).toBe('file:///opt/Muse%20Next/index.html');
  });

  it('开发：身份为开发服务器的纯 origin，加载地址原样使用配置值', () => {
    const entry = resolvePageEntry({ devServerUrl: 'http://localhost:5173', indexFilePath: '/unused', platform: 'darwin' });
    expect(entry).toEqual({ loadUrl: 'http://localhost:5173', identity: { kind: 'dev-server', origin: 'http://localhost:5173' } });
    expect(matchesPageIdentity('http://localhost:5173/', entry.identity)).toBe(true);
    expect(matchesPageIdentity('http://localhost:5173.evil.test/', entry.identity)).toBe(false);
  });

  it('开发服务器地址带尾斜杠或路径：身份仍取纯 origin', () => {
    const entry = resolvePageEntry({ devServerUrl: 'http://localhost:5173/', indexFilePath: '/unused', platform: 'darwin' });
    expect(entry.identity).toEqual({ kind: 'dev-server', origin: 'http://localhost:5173' });
    expect(matchesPageIdentity('http://localhost:5173/', entry.identity)).toBe(true);
  });

  it('空字符串的开发服务器地址视为生产构建', () => {
    expect(resolvePageEntry({ devServerUrl: '', indexFilePath: '/opt/i.html', platform: 'linux' }).identity.kind).toBe('file');
  });

  it('非 http(s) 的开发服务器地址是配置错误', () => {
    expect(() => resolvePageEntry({ devServerUrl: 'file:///x', indexFilePath: '/opt/i.html', platform: 'linux' })).toThrow();
    expect(() => resolvePageEntry({ devServerUrl: 'not a url', indexFilePath: '/opt/i.html', platform: 'linux' })).toThrow();
  });
});
