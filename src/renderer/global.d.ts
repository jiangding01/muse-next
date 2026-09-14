import type { MuseDesktopApi } from '../shared/ipc';

declare global {
  interface Window {
    museDesktop: MuseDesktopApi;
  }
}

export {};
