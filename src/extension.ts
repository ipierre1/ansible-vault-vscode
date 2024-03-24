import * as vscode from "vscode";
import * as util from "./util";
import { Vault } from "ansible-vault";

const logs = vscode.window.createOutputChannel("Ansible Vault");

class VaultedLineCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
    const codeLenses: vscode.CodeLens[] = [];
    let hasVaultIndicator = false;

    for (let line = 0; line < document.lineCount; line++) {
      const text = document.lineAt(line).text;

      // Check for !vault | or $ANSIBLE_VAULT indicators
      if (text.includes("!vault |") || text.startsWith("$ANSIBLE_VAULT;")) {
        hasVaultIndicator = true;
        const range = new vscode.Range(line, 0, line, text.length);
        const decryptAction = new vscode.CodeLens(range, {
          title: "Decrypt",
          command: "extension.decryptVaultedLine",
          arguments: [document.uri, line],
        });
        codeLenses.push(decryptAction);
      } else {
        hasVaultIndicator = false;
      }
    }

    return codeLenses;
  }

  resolveCodeLens(
    codeLens: vscode.CodeLens,
    token: vscode.CancellationToken
  ): vscode.CodeLens | Thenable<vscode.CodeLens> {
    return codeLens;
  }
}

export function activate(context: vscode.ExtensionContext) {
  logs.appendLine(
    '🎉 Congratulations! Your extension "ansible-vault-vscode" is now active!'
  );

  const decryptCommand = vscode.commands.registerCommand(
    "extension.decryptVaultedLine",
    async (uri: vscode.Uri, line: number) => {
      const editor = vscode.window.activeTextEditor;
      const document = await vscode.workspace.openTextDocument(uri);
      const text = document.getText();
      let vaultStart = text.indexOf(
        "!vault |",
        document.offsetAt(new vscode.Position(line, 0))
      );
      if (vaultStart === -1) {
        vaultStart = 0;
      }
      if (editor && vaultStart !== -1) {
        let vaultEnd = text.indexOf("$ANSIBLE_VAULT;", vaultStart);
        if (vaultEnd === -1) {
          // Vault is at the end of the file
          vaultEnd = text.length;
        } else {
          // Move the vaultEnd to the end of the vaulted section
          if (vaultStart === 0) {
            vaultEnd = -1;
          } else {
            vaultEnd = text.indexOf("\n", vaultEnd); // Find the end of the current line
            while (text.charAt(vaultEnd + 1) === " ") {
              vaultEnd = text.indexOf("\n", vaultEnd + 1); // Skip lines starting with space
            }
          }
          if (vaultEnd === -1) {
            // Vault is at the end of the file
            vaultEnd = text.length;
          }
          // Check if the content between vaultStart and vaultEnd is hexadecimal
          const vaultContent = text.substring(vaultStart, vaultEnd);
          const hexadecimalRegex = /^[0-9a-fA-F]+$/;
          if (!hexadecimalRegex.test(vaultContent.replace(/\s/g, ""))) {
            // Content is not valid hexadecimal, so set vaultEnd to the end of the line
            vaultEnd = text.indexOf("\n", vaultEnd);
            if (vaultEnd === -1) {
              // Vault is at the end of the file
              vaultEnd = text.length;
            }
          }
        }
        const selection = new vscode.Selection(
          document.positionAt(vaultStart),
          document.positionAt(vaultEnd)
        );
        editor.selection = selection; // Set selection to the vaulted section
        vscode.commands.executeCommand("extension.ansibleVault"); // Call toggleEncrypt command
      }
    }
  );

  const toggleEncrypt = async () => {
    logs.appendLine("🔐 Starting new encrypt or decrypt session.");
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const selection = editor.selection;
    if (!selection) {
      return;
    }

    const config = vscode.workspace.getConfiguration("ansibleVault");
    const doc = editor.document;
    let keypath = "";
    let pass: any = "";

    // Read `ansible.cfg`
    const configFileInWorkspacePath = util.getConfigFileInWorkspace(
      logs,
      editor.document.uri
    );
    let otherPath = util.findAnsibleCfgFile(
      logs,
      editor.document.uri.fsPath,
      "ansible.cfg"
    );

    if (otherPath !== undefined) {
      otherPath = util.verifyAnsibleDirectory(
        logs,
        editor.document.uri,
        otherPath
      );
    }

    let keyInCfg: string,
      vaultIds: false | Array<string>,
      vaultPass: false | { [key: string]: string };
    // eslint-disable-next-line prefer-const
    [keyInCfg, vaultIds, vaultPass] = util.scanAnsibleCfg(
      logs,
      otherPath,
      configFileInWorkspacePath
    );

    const text = editor.document.getText(selection);

    let checkText = editor.document.getText(selection);
    // const vaultId = await encryptVaultId(vaultIds);

    let vaultId: string;
    if (!checkText) {
      checkText = editor.document.getText();
    }
    // Check if there is no selection and the content is encrypted
    if (getInlineTextType(checkText) === "encrypted") {
      // Search for a vault ID in the content
      const extractedVaultId = extractVaultId(checkText);
      if (extractedVaultId) {
        vaultId = extractedVaultId;
      } else {
        // Use encryptVaultId if no vault ID is found in the encrypted content
        vaultId = await encryptVaultId(vaultIds);
      }
    } else {
      // Use encryptVaultId function otherwise
      vaultId = await encryptVaultId(vaultIds);
    }

    // Extract `ansible-vault` password
    if (keyInCfg) {
      vscode.window.showInformationMessage(
        `Getting vault keyFile from ${keyInCfg}`
      );
      if (vaultPass) {
        if (vaultPass["default"] !== undefined) {
          pass = util.findPassword(
            logs,
            editor.document.uri.fsPath,
            vaultPass["default"]
          );
        } else if (vaultPass[vaultId] !== undefined) {
          pass = util.findPassword(
            logs,
            editor.document.uri.fsPath,
            vaultPass[vaultId]
          );
        } else {
          // Handle case when neither default nor vaultId specific password is found
          vscode.window.showErrorMessage(
            "No password found for the specified vault ID."
          );
          return;
        }
        if (!pass) {
          vscode.window.showErrorMessage(
            "No password found for the specified vault ID."
          );
          return;
        }
      }
    } else {
      if (config.keyFile) {
        if (isVaultIdList(config.keyFile)) {
          keypath = config.keyFile.trim();
          vaultIds = util.getVaultIdList(keypath);
        } else {
          keypath = util.untildify(config.keyFile.trim());
        }
      }

      // Need user to input the ansible-vault pass
      if (!keypath) {
        pass = config.keyPass;

        if (!pass) {
          await vscode.window
            .showInputBox({ prompt: "Enter the ansible-vault password: " })
            .then((val) => {
              pass = val;
            });
        }
      }
    }

    // Go encrypt / decrypt
    if (text) {
      const type = getInlineTextType(text);

      if (type === "plaintext") {
        logs.appendLine(`🔒 Encrypt selected text`);

        let encryptedText = await encrypt(text, pass, vaultId);
        encryptedText = "!vault |\n" + encryptedText;
        editor.edit((editBuilder) => {
          editBuilder.replace(
            selection,
            encryptedText.replace(
              /\n/g,
              "\n" + " ".repeat(selection.start.character)
            )
          );
        });
      } else if (type === "encrypted") {
        logs.appendLine(`🔓 Decrypt selected text`);
        const decryptedText = await decrypt(
          text
            .replace("!vault |", "")
            .trim()
            .replace(/[^\S\r\n]+/gm, ""),
          pass,
          vaultId
        );
        if (decryptedText === undefined) {
          vscode.window.showErrorMessage(`Decryption failed: Invalid Vault`);
        } else {
          editor.edit((editBuilder) => {
            editBuilder.replace(selection, decryptedText);
          });
        }
      }
    } else {
      const content = editor.document.getText();
      const type = getTextType(content);

      if (type === "plaintext") {
        logs.appendLine(`🔒 Encrypt entire file`);

        const encryptedText = await encrypt(content, pass, vaultId);
        editor.edit((builder) => {
          builder.replace(
            new vscode.Range(
              doc.lineAt(0).range.start,
              doc.lineAt(doc.lineCount - 1).range.end
            ),
            encryptedText
          );
        });

        vscode.window.showInformationMessage(
          `File encrypted: '${doc.fileName}'`
        );
      } else if (type === "encrypted") {
        logs.appendLine(`🔓 Decrypt entire file`);
        const decryptedText = await decrypt(content, pass, vaultId);
        if (decryptedText === undefined) {
          vscode.window.showErrorMessage(`Decryption failed: Invalid Vault`);
        } else {
          editor.edit((builder) => {
            builder.replace(
              new vscode.Range(
                doc.lineAt(0).range.start,
                doc.lineAt(doc.lineCount - 1).range.end
              ),
              decryptedText
            );
          });
          vscode.window.showInformationMessage(
            `File decrypted: '${doc.fileName}'`
          );
        }
      }
    }
  };

  const selectVaultId = async () => {
    logs.appendLine("✏️ Trying to write VaultID into settings");

    const editor = vscode.window.activeTextEditor;
    let configFileInWorkspacePath = undefined;
    let otherPath = undefined;
    if (editor) {
      configFileInWorkspacePath = util.getConfigFileInWorkspace(
        logs,
        editor.document.uri
      );
      otherPath = util.findAnsibleCfgFile(
        logs,
        editor.document.uri.fsPath,
        "ansible.cfg"
      );
    } else {
      vscode.window.showWarningMessage(
        "No editor opened! Failed to determine current workspace root folder"
      );
    }
    const config = vscode.workspace.getConfiguration("ansibleVault");

    let keyInCfg: string,
      vaultIds: false | Array<string>,
      vaultPass: false | { [key: string]: string };
    // eslint-disable-next-line prefer-const
    [keyInCfg, vaultIds, vaultPass] = util.scanAnsibleCfg(
      logs,
      otherPath,
      configFileInWorkspacePath
    );
    // Try to get vault list from workspace config
    if (!keyInCfg && !!config.keyFile && isVaultIdList(config.keyFile)) {
      vaultIds = util.getVaultIdList(config.keyFile);
    }
    if (!vaultIds || !vaultIds.length) {
      vscode.window.showWarningMessage(
        `Couldn't find proper 'vault_identity_list' in your config files`
      );
      return;
    }
    const selection = await chooseVaultId(vaultIds);
    if (selection) {
      config.update("encryptVaultId", selection, false);
      vscode.window.showInformationMessage(
        `'encrypt_vault_id' is set to '${selection}'`
      );
    }
  };

  const clearVaultIdSelection = async () => {
    logs.appendLine(`🗑️ Clear 'encryptVaultId' setting`);
    const config = vscode.workspace.getConfiguration("ansibleVault");
    config.update("encryptVaultId", "", false);
    vscode.window.showInformationMessage(`'encrypt_vault_id' is set to ''`);
  };

  const codeLensProvider = new VaultedLineCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { scheme: "file", pattern: "**/*.{yaml,yml}" },
      codeLensProvider
    )
  );

  context.subscriptions.push(decryptCommand);

  const disposable = vscode.commands.registerCommand(
    "extension.ansibleVault",
    toggleEncrypt
  );
  context.subscriptions.push(disposable);

  const selectVaultIdCommand = vscode.commands.registerCommand(
    "extension.ansibleVault.selectVaultId",
    selectVaultId
  );
  context.subscriptions.push(selectVaultIdCommand);

  const clearVaultIdSelectionCommand = vscode.commands.registerCommand(
    "extension.ansibleVault.clearVaultIdSelection",
    clearVaultIdSelection
  );
  context.subscriptions.push(clearVaultIdSelectionCommand);
}

export function deactivate() {}

// Returns whether the selected text is encrypted or in plain text.
const getInlineTextType = (text: string) => {
  if (text.trim().startsWith("!vault |")) {
    text = text.replace("!vault |", "");
  }

  return text.trim().startsWith("$ANSIBLE_VAULT;") ? "encrypted" : "plaintext";
};

// Returns whether the file is encrypted or in plain text.
const getTextType = (text: string) => {
  return text.indexOf("$ANSIBLE_VAULT;") === 0 ? "encrypted" : "plaintext";
};

const encrypt = async (text: string, pass: string, encryptVaultId: any) => {
  const vault = new Vault({ password: pass });

  try {
    if (encryptVaultId) {
      const encryptedContent = await vault.encrypt(text, encryptVaultId);
      return <string>encryptedContent;
    } else {
      const encryptedContent = await vault.encrypt(text, "");
      return <string>encryptedContent;
    }
  } catch (error: any) {
    console.error("Encryption failed:", error);
    vscode.window.showErrorMessage(`Encryption failed: ${error.message}`);
    throw error;
  }
};

const decrypt = async (text: string, pass: string, encryptVaultId: any) => {
  const vault = new Vault({ password: pass });
  let decryptedContent = undefined;

  try {
    if (encryptVaultId) {
      decryptedContent = await vault.decrypt(text, encryptVaultId);
    } else {
      decryptedContent = await vault.decrypt(text, "");
    }
  } catch (error: any) {
    console.error("Decryption failed:", error);
    vscode.window.showErrorMessage(`Decryption failed: ${error.message}`);
    // Instead of throwing an error, return the original text
    return text;
  }
  return <string>decryptedContent;
};

const encryptVaultId = async (vaultIds: false | Array<string>) => {
  if (!vaultIds) {
    return "";
  }
  const config = vscode.workspace.getConfiguration("ansibleVaultInline");
  if (
    !!config.get("encryptVaultId") &&
    vaultIds.includes(config.encryptVaultId)
  ) {
    return config.encryptVaultId;
  }
  if (vaultIds.length === 1) {
    return vaultIds[0];
  }
  return chooseVaultId(vaultIds);
};

const chooseVaultId = async (vaultIds: Array<string>) => {
  return vscode.window.showQuickPick(vaultIds, {
    placeHolder: "Choose ansible vault ID for encryption: ",
    canPickMany: false,
  });
};

const isVaultIdList = (string: string) => {
  return string.includes("@");
};

const extractVaultId = (encryptedContent: string): string | undefined => {
  // Remove leading "!vault |" if present
  encryptedContent = encryptedContent
    .replace("!vault |", "")
    .trim()
    .replace(/[^\S\r\n]+/gm, "");

  // Remove whitespace and escape sequences
  const [header, ...hexValues] = encryptedContent.split(/\r?\n/);

  // Check if the content starts with $ANSIBLE_VAULT
  if (header.startsWith("$ANSIBLE_VAULT")) {
    // If found, split the content by semicolon to extract the parts
    const parts = header.split(";");
    // Check if the parts contain the required information
    if (parts.length >= 4) {
      // Extract the vault ID from the parts
      return parts[3];
    }
  }
  // Return undefined if the content doesn't match the expected format
  return undefined;
};
