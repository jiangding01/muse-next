/**
 * smoke 窗口工厂与页面调用（M3 T1b-2b-1）。
 *
 * - 每个窗口都用与产品 `src/main/main.ts` 相同的安全 webPreferences：preload 为 runner 用 vite 打包的生产 `src/preload/preload.ts`
 *   源码（不是 Forge 的构建产物）、`sandbox: true`、
 *   `contextIsolation: true`、`nodeIntegration: false`。测试专属差异只有显式参数：`subframePreload`（仅 `reject.subframe`，
 *   让 preload 进入子 frame，以证明 main 侧 mainFrame 校验）与 `partition`（仅导航竞态用例，隔离 `protocol.handle`）。
 * - 登记与生命周期事件一律经生产 `wireOpenIpcWindow`；`wire: false` 只用于「未登记窗口」用例。
 * - 页面调用经主 frame 的 `WebFrameMain.executeJavaScript` 在页面主世界执行，IPC 由页面经 `window.museDesktop` 发起；每次调用都有超时。
 */

import { BrowserWindow } from 'electron';

import type { OpenIpcHandle } from '../../../src/main/ipc/registerOpenIpc';
import { wireOpenIpcWindow } from '../../../src/main/ipc/wireOpenIpcWindow';
import { withTimeout } from './harness';
import { parseActivationReply, parseOpenReply, parsePageResult } from './replies';
import type { ActivationReply, OpenReply, PageResult, Ticket } from './replies';

export const PAGE_CALL_TIMEOUT_MS = 8_000;

export interface WindowOptions {
  /** 默认 true：经生产 `wireOpenIpcWindow` 登记。 */
  readonly wire?: boolean;
  /** 默认可信页面 `loadUrl`。 */
  readonly url?: string;
  /** 测试专属：preload 也注入子 frame（`nodeIntegrationInSubFrames`），只用于 sender 子 frame 用例。 */
  readonly subframePreload?: boolean;
  /** 测试专属：独立 session 分区（导航竞态用例在该分区上拦截 file 协议）。 */
  readonly partition?: string;
  /** 真实原生对话框用例需要可见窗口；默认隐藏。 */
  readonly show?: boolean;
  /** 默认 true：创建后等待首次加载完成。 */
  readonly waitLoad?: boolean;
}

export interface SmokeWindow {
  readonly win: BrowserWindow;
  /** webContents id（未登记窗口同样给出，便于断言状态未变）。 */
  readonly ownerId: number;
  /** 创建窗口时实际传入的安全相关 webPreferences（配置层证据；运行时证据见 `evidence.ts`）。 */
  readonly webPreferences: { readonly sandbox: boolean; readonly contextIsolation: boolean; readonly nodeIntegration: boolean };
  /** 在主 frame 页面中执行表达式（可 await），返回正常值或页面侧错误文本。 */
  call(expression: string, timeoutMs?: number): Promise<PageResult>;
  open(timeoutMs?: number): Promise<OpenReply>;
  /** 原始 invoke 结果：被 main 拒绝时为 `{ ok: false, error }`。 */
  openRaw(timeoutMs?: number): Promise<PageResult>;
  activate(ticket: Ticket): Promise<ActivationReply>;
  reject(ticket: Ticket): Promise<ActivationReply>;
  /** 等待下一次主 frame 加载完成（reload / 导航之后）。 */
  nextLoad(timeoutMs?: number): Promise<void>;
}

export interface WindowFactoryDeps {
  readonly openIpc: OpenIpcHandle<BrowserWindow>;
  readonly preloadPath: string;
  readonly defaultUrl: string;
}

export interface WindowFactory {
  create(options?: WindowOptions): Promise<SmokeWindow>;
  /** 关闭本工厂创建且仍存活的全部窗口（用例收尾）。 */
  closeAll(): Promise<void>;
}

/** 页面主世界中的包装：把表达式结果或异常统一成可结构化克隆的对象。 */
export function wrapExpression(expression: string): string {
  return `(async () => { try { return { ok: true, value: await (${expression}) }; } catch (error) { return { ok: false, error: String(error && error.message ? error.message : error) }; } })()`;
}

export async function evaluate(run: (code: string) => Promise<unknown>, expression: string, timeoutMs: number): Promise<PageResult> {
  try {
    const raw: unknown = await withTimeout(run(wrapExpression(expression)), timeoutMs, `page call ${expression.slice(0, 80)}`);
    return parsePageResult(raw);
  } catch (error) {
    return { ok: false, error: `harness: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function waitForLoad(win: BrowserWindow, timeoutMs: number): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      const contents = win.webContents;
      const onLoad = (): void => {
        contents.removeListener('did-fail-load', onFail);
        resolve();
      };
      const onFail = (_event: unknown, code: number, description: string, _url: string, isMainFrame: boolean): void => {
        if (!isMainFrame) return;
        contents.removeListener('did-finish-load', onLoad);
        reject(new Error(`did-fail-load ${String(code)} ${description}`));
      };
      contents.once('did-finish-load', onLoad);
      contents.on('did-fail-load', onFail);
    }),
    timeoutMs,
    'page load',
  );
}

export function createWindowFactory(deps: WindowFactoryDeps): WindowFactory {
  const alive = new Set<BrowserWindow>();

  async function create(options: WindowOptions = {}): Promise<SmokeWindow> {
    const webPreferences = {
      preload: deps.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(options.subframePreload === true ? { nodeIntegrationInSubFrames: true } : {}),
      ...(options.partition === undefined ? {} : { partition: options.partition }),
    };
    const win = new BrowserWindow({ width: 640, height: 480, show: options.show ?? false, webPreferences });
    alive.add(win);
    win.once('closed', () => alive.delete(win));
    const ownerId = options.wire === false ? win.webContents.id : wireOpenIpcWindow(deps.openIpc, win);
    const contents = win.webContents;
    // 用 WebFrameMain 而不是 webContents.executeJavaScript：后者在主 frame 加载中会排队到加载结束，无法在「导航已开始、
    // 未提交」窗口期内驱动旧文档；前者立即在当前已提交的主 frame 中执行。
    const run = (code: string): Promise<unknown> => contents.mainFrame.executeJavaScript(code, true);
    const call = (expression: string, timeoutMs = PAGE_CALL_TIMEOUT_MS): Promise<PageResult> => evaluate(run, expression, timeoutMs);
    const openRaw = (timeoutMs?: number): Promise<PageResult> => call('window.museDesktop.openDocument()', timeoutMs);
    const smokeWindow: SmokeWindow = {
      win,
      ownerId,
      webPreferences: {
        sandbox: webPreferences.sandbox,
        contextIsolation: webPreferences.contextIsolation,
        nodeIntegration: webPreferences.nodeIntegration,
      },
      call,
      openRaw,
      open: async (timeoutMs) => {
        const result = await openRaw(timeoutMs);
        return result.ok ? parseOpenReply(result.value) : { kind: 'invalid', raw: result.error };
      },
      activate: async (ticket) => {
        const result = await call(`window.museDesktop.activateDocument(${JSON.stringify(ticket)})`);
        return result.ok ? parseActivationReply(result.value) : { invalid: result.error };
      },
      reject: async (ticket) => {
        const result = await call(`window.museDesktop.rejectDocument(${JSON.stringify(ticket)})`);
        return result.ok ? parseActivationReply(result.value) : { invalid: result.error };
      },
      nextLoad: (timeoutMs = PAGE_CALL_TIMEOUT_MS) => waitForLoad(win, timeoutMs),
    };
    const url = options.url ?? deps.defaultUrl;
    if (options.waitLoad === false) {
      void win.loadURL(url).catch(() => undefined);
    } else {
      const loaded = waitForLoad(win, PAGE_CALL_TIMEOUT_MS);
      void win.loadURL(url).catch(() => undefined);
      await loaded;
    }
    return smokeWindow;
  }

  async function closeAll(): Promise<void> {
    for (const win of [...alive]) {
      if (win.isDestroyed()) {
        alive.delete(win);
        continue;
      }
      const closed = new Promise<void>((resolve) => win.once('closed', () => resolve()));
      win.close();
      try {
        await withTimeout(closed, 3_000, 'window close');
      } catch {
        // close 被阻塞（不应发生）：不在这里 destroy——留给调用方的 orphan / 清理断言暴露问题。
      }
    }
  }

  return { create, closeAll };
}
