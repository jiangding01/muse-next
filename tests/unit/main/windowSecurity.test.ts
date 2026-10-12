/**
 * M3 T1c-1：窗口安全接线 `wireWindowSecurity`。
 *
 * 用记录监听器的 fake webContents 证明：每个窗口恰好注册一次弹窗处理器与三个事件；弹窗一律 deny；主 frame 只能导航到可信页面身份
 * （file 与 dev-server 两种身份）；子 frame 的任何导航都被拦截；webview 一律拦截；先拦截、后通知 observer，observer 抛错不影响拦截。
 * 接线后的真实 Electron 事件语义由真实窗口 smoke（`risk.subframe-parent-bridge`、`prod.*`）验证。
 */

import { describe, expect, it } from 'vitest';

import { wireWindowSecurity } from '../../../src/main/security/windowSecurity';
import type {
  NavigationAttemptLike,
  WindowOpenDetailsLike,
  WindowSecurityBlock,
  WindowSecurityContentsLike,
} from '../../../src/main/security/windowSecurity';
import type { PageIdentity } from '../../../src/main/open/ipcValidation';

const FILE_IDENTITY: PageIdentity = { kind: 'file', url: 'file:///app/.vite/renderer/main_window/index.html' };
const DEV_IDENTITY: PageIdentity = { kind: 'dev-server', origin: 'http://localhost:5173' };

type OpenHandler = (details: WindowOpenDetailsLike) => { readonly action: 'deny' };
type Listener = (attempt: NavigationAttemptLike) => void;

interface FakeContents extends WindowSecurityContentsLike {
  readonly registrations: string[];
  openHandler(): OpenHandler;
  emit(event: string, attempt: NavigationAttemptLike): void;
}

function fakeContents(): FakeContents {
  const listeners = new Map<string, Listener[]>();
  const registrations: string[] = [];
  let handler: OpenHandler | null = null;
  return {
    registrations,
    setWindowOpenHandler: (next: OpenHandler) => {
      registrations.push('setWindowOpenHandler');
      handler = next;
    },
    on: (event: string, listener: Listener) => {
      registrations.push(event);
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    openHandler: () => {
      if (handler === null) throw new Error('no window open handler');
      return handler;
    },
    emit: (event, attempt) => {
      for (const listener of listeners.get(event) ?? []) listener(attempt);
    },
  };
}

interface Attempt extends NavigationAttemptLike {
  readonly prevented: () => boolean;
}

function attempt(url: string, isMainFrame: boolean): Attempt {
  let prevented = false;
  return {
    url,
    isMainFrame,
    preventDefault: () => {
      prevented = true;
    },
    prevented: () => prevented,
  };
}

function wired(identity: PageIdentity = FILE_IDENTITY): { readonly contents: FakeContents; readonly blocks: WindowSecurityBlock[] } {
  const contents = fakeContents();
  const blocks: WindowSecurityBlock[] = [];
  wireWindowSecurity(contents, identity, (block) => blocks.push(block));
  return { contents, blocks };
}

describe('wireWindowSecurity —— 注册', () => {
  it('每个窗口恰好注册一次弹窗处理器与三个事件', () => {
    const { contents } = wired();
    expect(contents.registrations).toEqual(['setWindowOpenHandler', 'will-navigate', 'will-frame-navigate', 'will-attach-webview']);
  });
});

describe('wireWindowSecurity —— 弹窗', () => {
  it.each(['about:blank', FILE_IDENTITY.url, 'https://example.com/', 'data:text/html,x'])('%s 一律 deny 并通知', (url) => {
    const { contents, blocks } = wired();
    expect(contents.openHandler()({ url })).toEqual({ action: 'deny' });
    expect(blocks).toEqual([{ kind: 'popup', event: 'window-open', url }]);
  });
});

describe('wireWindowSecurity —— 主 frame 导航（will-navigate）', () => {
  it.each([FILE_IDENTITY.url, `${FILE_IDENTITY.url}#section`])('可信页面身份 %s 放行，不通知', (url) => {
    const { contents, blocks } = wired();
    const navigation = attempt(url, true);
    contents.emit('will-navigate', navigation);
    expect(navigation.prevented()).toBe(false);
    expect(blocks).toEqual([]);
  });

  it.each([
    'file:///app/.vite/renderer/main_window/other.html',
    `${FILE_IDENTITY.url}?x=1`,
    'file:///etc/passwd',
    'data:text/html,<p>x</p>',
    'http://127.0.0.1:9/',
    'https://example.com/index.html',
    'javascript:alert(1)',
    'not a url',
  ])('其它目标 %s 被拦截并通知', (url) => {
    const { contents, blocks } = wired();
    const navigation = attempt(url, true);
    contents.emit('will-navigate', navigation);
    expect(navigation.prevented()).toBe(true);
    expect(blocks).toEqual([{ kind: 'navigation', event: 'will-navigate', url }]);
  });

  it('dev-server 身份：同 origin 的 / 与 /index.html 放行，其它路径、其它端口与 file 被拦截', () => {
    const { contents } = wired(DEV_IDENTITY);
    const verdicts = ['http://localhost:5173/', 'http://localhost:5173/index.html', 'http://localhost:5173/other', 'http://localhost:5174/', FILE_IDENTITY.url].map(
      (url) => {
        const navigation = attempt(url, true);
        contents.emit('will-navigate', navigation);
        return navigation.prevented();
      },
    );
    expect(verdicts).toEqual([false, false, true, true, true]);
  });
});

describe('wireWindowSecurity —— 子 frame 与主 frame（will-frame-navigate）', () => {
  it.each([FILE_IDENTITY.url, 'about:blank', 'about:srcdoc', 'data:text/html,x', 'https://example.com/'])('子 frame 导航到 %s 一律拦截', (url) => {
    const { contents, blocks } = wired();
    const navigation = attempt(url, false);
    contents.emit('will-frame-navigate', navigation);
    expect(navigation.prevented()).toBe(true);
    expect(blocks).toEqual([{ kind: 'subframe-navigation', event: 'will-frame-navigate', url }]);
  });

  it('主 frame：可信页面放行；其它目标按导航拦截', () => {
    const { contents, blocks } = wired();
    const trusted = attempt(FILE_IDENTITY.url, true);
    const foreign = attempt('file:///app/foreign.html', true);
    contents.emit('will-frame-navigate', trusted);
    contents.emit('will-frame-navigate', foreign);
    expect([trusted.prevented(), foreign.prevented()]).toEqual([false, true]);
    expect(blocks).toEqual([{ kind: 'navigation', event: 'will-frame-navigate', url: 'file:///app/foreign.html' }]);
  });
});

describe('wireWindowSecurity —— webview 与 observer', () => {
  it('webview 一律拦截', () => {
    const { contents, blocks } = wired();
    const event = attempt('', true);
    contents.emit('will-attach-webview', event);
    expect(event.prevented()).toBe(true);
    expect(blocks).toEqual([{ kind: 'webview', event: 'will-attach-webview', url: '' }]);
  });

  it('先拦截、后通知：observer 看到的导航已被 preventDefault', () => {
    const contents = fakeContents();
    const seen: boolean[] = [];
    const navigation = attempt('file:///etc/passwd', true);
    wireWindowSecurity(contents, FILE_IDENTITY, () => seen.push(navigation.prevented()));
    contents.emit('will-navigate', navigation);
    expect(seen).toEqual([true]);
  });

  it('observer 抛错不影响拦截；不传 observer 同样拦截', () => {
    const throwing = fakeContents();
    wireWindowSecurity(throwing, FILE_IDENTITY, () => {
      throw new Error('observer failed');
    });
    const silent = fakeContents();
    wireWindowSecurity(silent, FILE_IDENTITY);
    for (const contents of [throwing, silent]) {
      const navigation = attempt('file:///etc/passwd', true);
      const frame = attempt(FILE_IDENTITY.url, false);
      const webview = attempt('', true);
      contents.emit('will-navigate', navigation);
      contents.emit('will-frame-navigate', frame);
      contents.emit('will-attach-webview', webview);
      expect([navigation.prevented(), frame.prevented(), webview.prevented()]).toEqual([true, true, true]);
      expect(contents.openHandler()({ url: 'about:blank' })).toEqual({ action: 'deny' });
    }
  });
});
