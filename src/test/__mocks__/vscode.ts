/**
 * Minimal vscode module mock for unit tests.
 * Provides only the surface area used by util.ts and the CodeLens provider.
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

export class Range {
  readonly start: { line: number; character: number };
  readonly end: { line: number; character: number };
  constructor(
    startLine: number,
    startCharacter: number,
    endLine: number,
    endCharacter: number,
  ) {
    this.start = { line: startLine, character: startCharacter };
    this.end = { line: endLine, character: endCharacter };
  }
}

export class CodeLens {
  constructor(
    readonly range: Range,
    readonly command?: { title: string; command: string; arguments?: unknown[] },
  ) {}
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
