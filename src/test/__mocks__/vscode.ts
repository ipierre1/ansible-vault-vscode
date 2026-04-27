/**
 * Minimal vscode module mock for unit tests.
 * Provides only the surface area used by util.ts.
 */

export interface OutputChannel {
  appendLine(value: string): void;
}

export class Uri {
  readonly fsPath: string;
  constructor(fsPath: string) {
    this.fsPath = fsPath;
  }
  static file(fsPath: string): Uri {
    return new Uri(fsPath);
  }
}

export const workspace = {
  workspaceFolders: undefined as Array<{ uri: { fsPath: string } }> | undefined,
  getWorkspaceFolder(_uri: unknown): { uri: { fsPath: string } } | undefined {
    return undefined;
  },
};

export const window = {
  createOutputChannel: (): OutputChannel => ({ appendLine: () => {} }),
};
