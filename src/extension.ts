import * as vscode from "vscode";
import {
  extractVaultId,
  findAnsibleCfgFile,
  findPassword,
  getConfigFileInWorkspace,
  getInlineTextType,
  getTextType,
  getVaultIdList,
  isVaultIdList,
  reindentText,
  scanAnsibleCfg,
  untildify,
  verifyAnsibleDirectory,
} from "./util";
import { Vault } from "ansible-vault";

const logs = vscode.window.createOutputChannel("Ansible Vault");

class VaultedLineCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
    const codeLenses: vscode.CodeLens[] = [];

    for (let line = 0; line < document.lineCount; line++) {
      const text = document.lineAt(line).text;
      if (text.includes("!vault |") || text.startsWith("$ANSIBLE_VAULT;")) {
        const range = new vscode.Range(line, 0, line, text.length);
        codeLenses.push(
          new vscode.CodeLens(range, {
            title: "Decrypt",
            command: "extension.decryptVaultedLine",
            arguments: [document.uri, line, false],
          }),
          new vscode.CodeLens(range, {
            title: "Rekey",
            command: "extension.decryptVaultedLine",
            arguments: [document.uri, line, true],
          }),
        );
      }
    }

    return codeLenses;
  }

  resolveCodeLens(
    codeLens: vscode.CodeLens,
    token: vscode.CancellationToken,
  ): vscode.CodeLens | Thenable<vscode.CodeLens> {
    return codeLens;
  }
}

export function activate(context: vscode.ExtensionContext) {
  logs.appendLine(
    '🎉 Congratulations! Your extension "ansible-vault-vscode" is now active!',
  );

  const decryptCommand = vscode.commands.registerCommand(
    "extension.decryptVaultedLine",
    async (uri: vscode.Uri, line: number, rekey: boolean) => {
      const editor = vscode.window.activeTextEditor;
      const document = await vscode.workspace.openTextDocument(uri);
      const text = document.getText();
      let vaultStart = text.indexOf(
        "!vault |",
        document.offsetAt(new vscode.Position(line, 0)),
      );
      if (vaultStart === -1) {
        vaultStart = 0;
      }
      if (editor) {
        let vaultEnd = text.indexOf("$ANSIBLE_VAULT;", vaultStart);
        if (vaultEnd === -1) {
          vaultEnd = text.length;
        } else {
          if (vaultStart === 0) {
            vaultEnd = -1;
          } else {
            vaultEnd = text.indexOf("\n", vaultEnd);
            let indent = "";
            if (text.charAt(vaultEnd + 1) === " ") {
              let i = 1;
              while (text.charAt(vaultEnd + i) === " ") {
                indent += " ";
                i++;
              }
            }
            while (
              text.slice(vaultEnd + 1, vaultEnd + 1 + indent.length) === indent
            ) {
              vaultEnd = text.indexOf("\n", vaultEnd + 1);
            }
          }
          if (vaultEnd === -1) {
            vaultEnd = text.length;
          }
          const vaultContent = text.substring(vaultStart, vaultEnd);
          if (!/^[0-9a-fA-F\s]+$/.test(vaultContent)) {
            vaultEnd = text.indexOf("\n", vaultEnd);
            if (vaultEnd === -1) {
              vaultEnd = text.length;
            }
          }
        }
        editor.selection = new vscode.Selection(
          document.positionAt(vaultStart),
          document.positionAt(vaultEnd),
        );
        await vscode.commands.executeCommand(
          rekey ? "extension.ansibleVault.rekey" : "extension.ansibleVault",
        );
      }
    },
  );

  // isRekey=true: decrypt first, then immediately re-encrypt with a new password.
  const encryptDecrypt = async (isRekey = false): Promise<void> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const selection = editor.selection;
    const config = vscode.workspace.getConfiguration("ansibleVault");
    const doc = editor.document;

    // Locate ansible.cfg
    const configFileInWorkspacePath = getConfigFileInWorkspace(
      editor.document.uri,
    );
    let otherPath = findAnsibleCfgFile(
      logs,
      editor.document.uri.fsPath,
      "ansible.cfg",
    );
    if (otherPath !== undefined) {
      otherPath = verifyAnsibleDirectory(editor.document.uri, otherPath);
    }

    const [keyInCfg, initialVaultIds, vaultPass] = scanAnsibleCfg(
      logs,
      otherPath,
      configFileInWorkspacePath,
    );
    const vaultIds = initialVaultIds;

    // Determine text to operate on and text to inspect for type/vault-id
    const selectedText = editor.document.getText(selection);
    const checkText = selectedText || editor.document.getText();

    // Resolve vault ID: extract from header when decrypting, otherwise prompt/use saved
    const extractedVaultId =
      getInlineTextType(checkText) === "encrypted"
        ? extractVaultId(checkText)
        : undefined;
    const vaultId = extractedVaultId ?? (await encryptVaultId(vaultIds));

    // Resolve password
    let pass: string | undefined;

    if (config.keyFile || config.keyPass) {
      if (config.keyFile) {
        const keyFile = (config.keyFile as string).trim();
        if (!isVaultIdList(keyFile)) {
          pass = findPassword(
            logs,
            editor.document.uri.fsPath,
            untildify(keyFile),
          );
        }
      }
      if (config.keyPass) {
        pass = config.keyPass as string;
      }
    } else if (keyInCfg && vaultPass) {
      vscode.window.showInformationMessage(
        `Getting vault password from ${keyInCfg}`,
      );
      const passwordFile = vaultPass["default"] ?? vaultPass[vaultId ?? ""];
      if (passwordFile) {
        pass = findPassword(logs, editor.document.uri.fsPath, passwordFile);
      }
      if (!pass) {
        logs.appendLine(
          `No password file found for vault ID '${vaultId}' in ${keyInCfg}`,
        );
      }
    }

    if (!pass) {
      pass = await vscode.window.showInputBox({
        prompt: isRekey
          ? "Enter the CURRENT ansible-vault password (to decrypt):"
          : "Enter the ansible-vault password:",
        password: true,
      });
    }

    if (!pass) {
      vscode.window.showWarningMessage(
        "No password provided. Operation cancelled.",
      );
      return;
    }

    // Perform encrypt / decrypt on selection or full file
    if (selectedText) {
      const type = getInlineTextType(selectedText);

      if (type === "plaintext") {
        logs.appendLine(`🔒 Encrypt selected text`);
        const status = vscode.window.setStatusBarMessage(
          "$(loading~spin) Encrypting...",
        );
        const encryptedText = await encrypt(selectedText, pass, vaultId);
        status.dispose();
        if (encryptedText) {
          await editor.edit((editBuilder) => {
            editBuilder.replace(
              selection,
              reindentText(
                encryptedText,
                getIndentationLevel(editor, selection),
                Number(editor.options.tabSize),
              ),
            );
          });
          if (!isRekey) {
            vscode.window.showInformationMessage("Selection encrypted.");
          }
        }
      } else if (type === "encrypted") {
        logs.appendLine(`🔓 Decrypt selected text`);
        const status = vscode.window.setStatusBarMessage(
          "$(loading~spin) Decrypting...",
        );
        const decryptedText = await decrypt(
          selectedText
            .replace("!vault |", "")
            .trim()
            .replace(/[^\S\r\n]+/gm, ""),
          pass,
          vaultId,
        );
        status.dispose();
        if (decryptedText === undefined) {
          vscode.window.showErrorMessage("Decryption failed: Invalid Vault");
        } else {
          await editor.edit((editBuilder) => {
            editBuilder.replace(selection, decryptedText);
          });
          if (!isRekey) {
            vscode.window.showInformationMessage("Selection decrypted.");
          }
        }
      }
    } else {
      const content = editor.document.getText();
      const type = getTextType(content);

      if (type === "plaintext") {
        logs.appendLine(`🔒 Encrypt entire file`);
        const status = vscode.window.setStatusBarMessage(
          "$(loading~spin) Encrypting...",
        );
        const encryptedText = await encrypt(content, pass, vaultId);
        status.dispose();
        if (encryptedText) {
          await editor.edit((builder) => {
            builder.replace(
              new vscode.Range(
                doc.lineAt(0).range.start,
                doc.lineAt(doc.lineCount - 1).range.end,
              ),
              encryptedText,
            );
          });
          if (!isRekey) {
            vscode.window.showInformationMessage(
              `File encrypted: '${doc.fileName}'`,
            );
          }
        }
      } else if (type === "encrypted") {
        logs.appendLine(`🔓 Decrypt entire file`);
        const status = vscode.window.setStatusBarMessage(
          "$(loading~spin) Decrypting...",
        );
        const decryptedText = await decrypt(content, pass, vaultId);
        status.dispose();
        if (decryptedText === undefined) {
          vscode.window.showErrorMessage("Decryption failed: Invalid Vault");
        } else {
          await editor.edit((builder) => {
            builder.replace(
              new vscode.Range(
                doc.lineAt(0).range.start,
                doc.lineAt(doc.lineCount - 1).range.end,
              ),
              decryptedText,
            );
          });
          if (!isRekey) {
            vscode.window.showInformationMessage(
              `File decrypted: '${doc.fileName}'`,
            );
          }
        }
      }
    }

    if (isRekey) {
      await encryptDecrypt(false);
    }
  };

  const toggleEncrypt = async () => {
    logs.appendLine("🔐 Starting new encrypt or decrypt session.");
    await encryptDecrypt(false);
  };

  const toggleRekey = async () => {
    logs.appendLine("🔐 Starting new rekey session.");
    await encryptDecrypt(true);
  };

  const selectVaultId = async () => {
    logs.appendLine("✏️ Trying to write VaultID into settings");

    const editor = vscode.window.activeTextEditor;
    let configFileInWorkspacePath: string | undefined;
    let otherPath: string | undefined;
    if (editor) {
      configFileInWorkspacePath = getConfigFileInWorkspace(editor.document.uri);
      otherPath = findAnsibleCfgFile(
        logs,
        editor.document.uri.fsPath,
        "ansible.cfg",
      );
    } else {
      vscode.window.showWarningMessage(
        "No editor opened. Failed to determine current workspace root folder.",
      );
    }

    const config = vscode.workspace.getConfiguration("ansibleVault");
    const [keyInCfg, initialVaultIds] = scanAnsibleCfg(
      logs,
      otherPath,
      configFileInWorkspacePath,
    );
    let vaultIds = initialVaultIds;

    if (
      !keyInCfg &&
      config.keyFile &&
      isVaultIdList(config.keyFile as string)
    ) {
      vaultIds = getVaultIdList((config.keyFile as string).trim());
    }
    if (!vaultIds?.length) {
      vscode.window.showWarningMessage(
        "Couldn't find a 'vault_identity_list' in your config files.",
      );
      return;
    }
    const selected = await chooseVaultId(vaultIds);
    if (selected) {
      config.update("encryptVaultId", selected, false);
      vscode.window.showInformationMessage(`Vault ID set to '${selected}'.`);
    }
  };

  const clearVaultIdSelection = async () => {
    logs.appendLine(`🗑️ Clear 'encryptVaultId' setting`);
    const config = vscode.workspace.getConfiguration("ansibleVault");
    await config.update("encryptVaultId", "", false);
    vscode.window.showInformationMessage("Vault ID selection cleared.");
  };

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { scheme: "file", pattern: "**/*.{yaml,yml}" },
      new VaultedLineCodeLensProvider(),
    ),
    decryptCommand,
    vscode.commands.registerCommand("extension.ansibleVault", toggleEncrypt),
    vscode.commands.registerCommand(
      "extension.ansibleVault.rekey",
      toggleRekey,
    ),
    vscode.commands.registerCommand(
      "extension.ansibleVault.selectVaultId",
      selectVaultId,
    ),
    vscode.commands.registerCommand(
      "extension.ansibleVault.clearVaultIdSelection",
      clearVaultIdSelection,
    ),
  );
}

export function deactivate() {}

const getIndentationLevel = (
  editor: vscode.TextEditor,
  selection: vscode.Selection,
): number => {
  if (!editor.options.tabSize) {
    throw new Error(
      "The `tabSize` option is not defined, this should never happen.",
    );
  }
  const startLine = editor.document.lineAt(selection.start.line).text;
  const leadingWhitespaces = startLine.match(/^\s*/)?.[0]?.length ?? 0;
  return leadingWhitespaces / Number(editor.options.tabSize);
};


const encrypt = async (
  text: string,
  pass: string,
  vaultId: string | undefined,
): Promise<string | undefined> => {
  const vault = new Vault({ password: pass });
  try {
    return (await vault.encrypt(text, vaultId ?? "")) as string;
  } catch (error: any) {
    logs.appendLine(`Encryption failed: ${error.message}`);
    vscode.window.showErrorMessage(`Encryption failed: ${error.message}`);
    return undefined;
  }
};

const decrypt = async (
  text: string,
  pass: string,
  vaultId: string | undefined,
): Promise<string | undefined> => {
  const vault = new Vault({ password: pass });
  try {
    return (await vault.decrypt(text, vaultId ?? "")) as string;
  } catch (error: any) {
    logs.appendLine(`❌ Decryption failed: ${error.message}`);
    vscode.window.showErrorMessage(`Decryption failed: ${error.message}`);
    return undefined;
  }
};

const encryptVaultId = async (
  vaultIds: string[] | undefined,
): Promise<string | undefined> => {
  if (!vaultIds?.length) {
    return undefined;
  }
  const config = vscode.workspace.getConfiguration("ansibleVault");
  const savedVaultId = config.get<string>("encryptVaultId");
  if (savedVaultId && vaultIds.includes(savedVaultId)) {
    return savedVaultId;
  }
  if (vaultIds.length === 1) {
    return vaultIds[0];
  }
  return chooseVaultId(vaultIds);
};

const chooseVaultId = (vaultIds: string[]): Thenable<string | undefined> => {
  return vscode.window.showQuickPick(vaultIds, {
    placeHolder: "Choose ansible vault ID for encryption:",
    canPickMany: false,
  });
};
