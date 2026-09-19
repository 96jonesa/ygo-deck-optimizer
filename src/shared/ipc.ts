export const IpcChannels = {
  appInfo: 'app:info',
} as const;

export interface AppInfo {
  version: string;
  electron: string;
  node: string;
  chrome: string;
  packaged: boolean;
}

/** The api exposed on window.api by the preload bridge. */
export interface RendererApi {
  getAppInfo(): Promise<AppInfo>;
}
