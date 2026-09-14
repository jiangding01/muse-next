export const IPC = {
  openScore: 'muse:open-score',
} as const;

export interface OpenedScoreFile {
  canceled: boolean;
  path?: string;
  content?: string;
  encoding?: 'utf8' | 'gb18030';
}

export interface MuseDesktopApi {
  openScore(): Promise<OpenedScoreFile>;
}
