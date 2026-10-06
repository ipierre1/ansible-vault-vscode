import { describe, it, expect } from "vitest";
import * as vscode from "vscode";
import { VaultedLineCodeLensProvider } from "../extension";

function makeDocument(content: string): vscode.TextDocument {
  const lines = content.split("\n");
  return {
    uri: vscode.Uri.file("/tmp/vars.yml"),
    lineCount: lines.length,
    lineAt: (line: number) => ({ text: lines[line] }),
  } as unknown as vscode.TextDocument;
}

function lensLines(content: string): number[] {
  const provider = new VaultedLineCodeLensProvider();
  const lenses = provider.provideCodeLenses(
    makeDocument(content),
    {} as vscode.CancellationToken,
  ) as vscode.CodeLens[];
  return lenses.map((lens) => lens.range.start.line);
}

describe("VaultedLineCodeLensProvider", () => {
  it("adds Decrypt and Rekey lenses on a !vault line", () => {
    const content = [
      "stack_secret_values:",
      "  db-password: !vault |",
      "            $ANSIBLE_VAULT;1.1;AES256",
      "            3865",
    ].join("\n");
    const provider = new VaultedLineCodeLensProvider();
    const lenses = provider.provideCodeLenses(
      makeDocument(content),
      {} as vscode.CancellationToken,
    ) as vscode.CodeLens[];

    expect(lenses.map((lens) => lens.command?.title)).toEqual([
      "Decrypt",
      "Rekey",
    ]);
    expect(lenses.map((lens) => lens.command?.arguments?.[1])).toEqual([1, 1]);
    expect(lenses.map((lens) => lens.command?.arguments?.[2])).toEqual([
      false,
      true,
    ]);
  });

  it("adds lenses on a vault-encrypted file header", () => {
    expect(lensLines("$ANSIBLE_VAULT;1.1;AES256\n3865")).toEqual([0, 0]);
  });

  it("adds no lens on a commented-out vault example", () => {
    const content = [
      "# stack_secret_values:",
      "#   db-password: !vault |",
      "#             $ANSIBLE_VAULT;1.1;AES256",
      "#             3865...",
    ].join("\n");
    expect(lensLines(content)).toEqual([]);
  });

  it("only adds lenses on the real vault next to a commented example", () => {
    const content = [
      "# db-password: !vault |",
      "#   $ANSIBLE_VAULT;1.1;AES256",
      "db-password: !vault |",
      "  $ANSIBLE_VAULT;1.1;AES256",
      "  3865",
    ].join("\n");
    expect(lensLines(content)).toEqual([2, 2]);
  });
});
