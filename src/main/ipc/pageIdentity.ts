/**
 * 应用页面的加载 URL 与可信页面身份（M3 T1b-2a，用户裁决 2 / 3）。
 *
 * - **可信入口只来自 main 的配置**：开发模式取 Forge 注入的 Vite 开发服务器地址；生产模式由入口文件的绝对路径经
 *   `pathToFileURL` 构造唯一的 `indexUrl`。main 用 `loadURL(loadUrl)` 加载，并用**同一个**字符串构造 `PageIdentity`，
 *   两者永不分别计算（symlink / realpath 形式不一致会导致不匹配，实测）。
 * - 不使用 `loadFile`：它内部用 `url.format` 拼接 URL，路径含字面 `%` 时无法加载（实测 ERR_FILE_NOT_FOUND）。
 * - Windows 上只把盘符规范化为大写（Chromium 的 file URL 规范化会这样做，Node 的 `pathToFileURL` 保留原大小写）；
 *   路径其余部分不做任何大小写折叠。Windows 真实行为由 T1b-2b 的窗口 smoke 最终确认。
 * - `webContents.getURL()` 只用于诊断比对，从不作为可信基准。
 */

import { pathToFileURL } from 'node:url';

import type { PageIdentity } from '../open/ipcValidation';

export interface PageEntryConfig {
  /** Forge 注入的 `MAIN_WINDOW_VITE_DEV_SERVER_URL`；生产构建为 undefined。 */
  readonly devServerUrl: string | undefined;
  /** 生产入口 `index.html` 的绝对路径。 */
  readonly indexFilePath: string;
  /** 运行平台（生产传 `process.platform`）。 */
  readonly platform: string;
}

export interface PageEntry {
  /** 交给 `loadURL` 的地址。 */
  readonly loadUrl: string;
  /** 与 `loadUrl` 同源构造的可信页面身份。 */
  readonly identity: PageIdentity;
}

const LOWERCASE_DRIVE = /^file:\/\/\/([a-z]):/;

/** `file:///c:/…` → `file:///C:/…`；其它 URL 原样返回。 */
export function uppercaseDriveLetter(fileUrl: string): string {
  return fileUrl.replace(LOWERCASE_DRIVE, (_match, drive: string) => `file:///${drive.toUpperCase()}:`);
}

/** 入口文件的 file URL：`pathToFileURL` 按目标平台编码（空格、`%`、`#`、`?`、非 ASCII 均百分号编码），Windows 再规范盘符。 */
export function fileIndexUrl(indexFilePath: string, platform: string): string {
  const windows = platform === 'win32';
  const href = pathToFileURL(indexFilePath, { windows }).href;
  return windows ? uppercaseDriveLetter(href) : href;
}

/** 按运行模式给出加载地址与可信身份；开发服务器地址不是合法的 http(s) URL 时视为配置错误抛出。 */
export function resolvePageEntry(config: PageEntryConfig): PageEntry {
  if (config.devServerUrl !== undefined && config.devServerUrl !== '') {
    const url = new URL(config.devServerUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('resolvePageEntry: dev server URL must be http(s)');
    }
    return { loadUrl: config.devServerUrl, identity: { kind: 'dev-server', origin: url.origin } };
  }
  const indexUrl = fileIndexUrl(config.indexFilePath, config.platform);
  return { loadUrl: indexUrl, identity: { kind: 'file', url: indexUrl } };
}
