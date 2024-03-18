import * as vscode from "vscode";
import untildify from "untildify";
import * as tmp from "tmp";
import * as fs from "fs";
import * as util from "./util";
import { Vault } from "ansible-vault";

const logs = vscode.window.createOutputChannel("Ansible Vault");

export function activate(context: vscode.ExtensionContext) {
  logs.appendLine(
    'Congratulations, your extension "ansible-vault-vscode" is now active!'
  );

  const toggleEncrypt = async () => {
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
    const rootPath = util.getRootPath(logs, editor.document.uri);
    const otherPath = util.findAnsibleCfgFile(logs, rootPath);
    let keyInCfg: string, vaultIds: false | Array<string>;
    // eslint-disable-next-line prefer-const
    [keyInCfg, vaultIds] = util.scanAnsibleCfg(logs, otherPath, rootPath);

    // Extract `ansible-vault` password
    if (keyInCfg) {
      logs.appendLine(`Getting vault keyfile from ${keyInCfg}`);
      vscode.window.showInformationMessage(
        `Getting vault keyfile from ${keyInCfg}`
      );
    } else {
      logs.appendLine(`Found nothing from config files`);

      if (config.keyfile) {
        if (isVaultIdList(config.keyfile)) {
          keypath = config.keyfile.trim();
          vaultIds = util.getVaultIdList(keypath);
        } else {
          keypath = untildify(config.keyfile.trim());
        }
      }

      // Need user to input the ansible-vault pass
      if (!keypath) {
        pass = config.keypass;

        if (!pass) {
          await vscode.window
            .showInputBox({ prompt: "Enter the ansible-vault keypass: " })
            .then((val) => {
              pass = val;
            });
        }

        keypath = tmp.tmpNameSync();
        fs.writeFileSync(keypath, pass, "utf8");
        logs.appendLine(`Wrote password to temporary file: '${keypath}'`);
      }
    }

    const text = editor.document.getText(selection);

    // Go encrypt / decrypt
    if (text) {
      const type = getInlineTextType(text);

      if (type === "plaintext") {
        logs.appendLine(`Encrypt selected text`);
        const vaultId = await encryptVaultId(vaultIds);

        let encryptedText = await encryptInline(
          text,
          rootPath,
          pass,
          vaultId,
        );
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
        logs.appendLine(`Decrypt selected text`);
        const test = text.replace('!vault |', '').trim().replace(/[^\S\r\n]+/gm, '');
        logs.appendLine(test);
        const decryptedText = await decryptInline(
          text.replace('!vault |', '').trim().replace(/[^\S\r\n]+/gm, ''),
          rootPath,
          pass,
          await encryptVaultId(vaultIds)
        );
        editor.edit((editBuilder) => {
          editBuilder.replace(selection, decryptedText);
        });
      }
    } else {
      const content = editor.document.getText();
      const type = getTextType(content);

      if (type === "plaintext") {
        logs.appendLine(`Encrypt entire file: '${content}'`);

        const encryptedText = await encryptInline(
          content,
          rootPath,
          pass,
          await encryptVaultId(vaultIds)
        );
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
        logs.appendLine(`Decrypt entire file: '${content}'`);
        const decryptedText = await decryptInline(
          content,
          rootPath,
          pass,
          await encryptVaultId(vaultIds)
        );
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

    if (!!pass && !!keypath) {
      fs.unlinkSync(keypath);
      logs.appendLine(`Removed temporary file: '${keypath}'`);
    }
  };

  const selectVaultId = async () => {
    logs.appendLine("Trying to write VaultID into settings");

    const editor = vscode.window.activeTextEditor;
    let rootPath = undefined;
    let otherPath = undefined;
    if (editor) {
      rootPath = util.getRootPath(logs, editor.document.uri);
      otherPath = util.findAnsibleCfgFile(logs, rootPath);
    } else {
      vscode.window.showWarningMessage(
        "No editor opened! Failed to determine current workspace root folder"
      );
    }
    const config = vscode.workspace.getConfiguration("ansibleVault");

    let keyInCfg: string, vaultIds: false | Array<string>;
    // eslint-disable-next-line prefer-const
    [keyInCfg, vaultIds] = util.scanAnsibleCfg(logs, otherPath, rootPath);
    // Try to get vault list from workspace config
    if (!keyInCfg && !!config.keyfile && isVaultIdList(config.keyfile)) {
      vaultIds = util.getVaultIdList(config.keyfile);
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
    logs.appendLine(`Clear 'encryptVaultId' setting`);
    const config = vscode.workspace.getConfiguration("ansibleVault");
    config.update("encryptVaultId", "", false);
    vscode.window.showInformationMessage(`'encrypt_vault_id' is set to ''`);
  };

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

const encryptInline = async (
  text: string,
  rootPath: string | undefined,
  pass: string,
  encryptVaultId: any
) => {
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

const decryptInline = async (
  text: string,
  rootPath: string | undefined,
  pass: string,
  encryptVaultId: any
) => {
  const vault = new Vault({ password: pass });

  try {
    if (encryptVaultId) {
      const decryptedContent = await vault.decrypt(text, encryptVaultId);
      return <string>decryptedContent;
    } else {
      const decryptedContent = await vault.decrypt(text, "");
      return <string>decryptedContent;
    }
  } catch (error: any) {
    console.error("Decryption failed:", error);
    vscode.window.showErrorMessage(`Decryption failed: ${error.message}`);
    throw error;
  }
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
