import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as ini from "ini";
import * as os from "os";

// --- Utility functions moved from extension.ts ---
export const getInlineTextType = (text: string) => {
  if (text.trim().startsWith("!vault |")) {
    text = text.replace("!vault |", "");
  }
  return text.trim().startsWith("$ANSIBLE_VAULT;") ? "encrypted" : "plaintext";
};

export const getTextType = (text: string) => {
  return text.indexOf("$ANSIBLE_VAULT;") === 0 ? "encrypted" : "plaintext";
};

export const extractVaultId = (encryptedContent: string): string | undefined => {
  encryptedContent = encryptedContent
    .replace("!vault |", "")
    .trim()
    .replace(/[^\S\r\n]+/gm, "");
  const [header, ...hexValues] = encryptedContent.split(/\r?\n/);
  if (header.startsWith("$ANSIBLE_VAULT")) {
    const parts = header.split(";");
    if (parts.length >= 4) {
      return parts[3];
    }
  }
  return undefined;
};

export const isVaultIdList = (string: string) => {
  return string.includes("@");
};

export function untildify(pathWithTilde: string) {
  const homeDirectory = os.homedir();
  if (typeof pathWithTilde !== "string") {
    throw new TypeError(`Expected a string, got ${typeof pathWithTilde}`);
  }
  return homeDirectory
    ? pathWithTilde.replace(/^~(?=$|\/|\\)/, homeDirectory)
    : pathWithTilde;
}

export function getConfigFileInWorkspace(
  logs: vscode.OutputChannel,
  editorDocumentUri: vscode.Uri
): string | undefined {
  if (vscode.workspace.workspaceFolders?.length) {
    return vscode.workspace.workspaceFolders[0].uri.fsPath;
  }
  const workspaceFolder =
    vscode.workspace.getWorkspaceFolder(editorDocumentUri);
  return workspaceFolder?.uri.fsPath;
}

export function verifyAnsibleDirectory(
  logs: vscode.OutputChannel,
  editorDocumentUri: vscode.Uri,
  ansibleConfigPath: string
): string | undefined {
  const editorDocumentDir = path.dirname(editorDocumentUri.fsPath);
  const absoluteAnsibleConfigPath = path.dirname(ansibleConfigPath);

  if (
    editorDocumentDir === absoluteAnsibleConfigPath ||
    editorDocumentDir.startsWith(absoluteAnsibleConfigPath + path.sep)
  ) {
    return ansibleConfigPath;
  }
  return undefined;
}

export function findAnsibleCfgFile(
  logs: vscode.OutputChannel,
  startPath: string | undefined,
  needle: string | undefined
): string | undefined {
  if (!startPath || !fs.existsSync(startPath)) {
    logs.appendLine(`Invalid start path: ${startPath}`);
    return undefined;
  }

  startPath = path.normalize(startPath);

  if (fs.lstatSync(startPath).isFile()) {
    startPath = path.dirname(startPath);
  }

  let currentDir = startPath;
  while (currentDir !== path.parse(currentDir).root) {
    const files = fs.readdirSync(currentDir);
    if (files.includes(needle || "")) {
      const filePath = path.join(currentDir, needle || "");
      if (fs.existsSync(filePath)) {
        return filePath;
      }
    }
    currentDir = path.dirname(currentDir);
  }
  return undefined;
}

export function scanAnsibleCfg(
  logs: vscode.OutputChannel,
  configFileInDirectoryPath: string | undefined = undefined,
  configFileInWorkspacePath: string | undefined = undefined
): [string, false | Array<string>, false | { [key: string]: string }] {
  const cfgFiles: string[] = [];

  if (process.platform !== "win32") {
    cfgFiles.push("~/.ansible.cfg", "/etc/ansible.cfg");
  }

  if (configFileInWorkspacePath) {
    cfgFiles.unshift(`${configFileInWorkspacePath}${path.sep}ansible.cfg`);
  }

  if (configFileInDirectoryPath) {
    cfgFiles.unshift(configFileInDirectoryPath);
  }

  if (process.env.ANSIBLE_CONFIG) {
    cfgFiles.unshift(process.env.ANSIBLE_CONFIG);
  }

  for (const cfgFile of cfgFiles) {
    const cfgPath = untildify(cfgFile);
    const cfg = getValueByCfg(logs, cfgPath);
    if (!!cfg && !!cfg.defaults) {
      if (
        !!cfg.defaults.vault_password_file &&
        !!cfg.defaults.vault_identity_list
      ) {
        logs.appendLine(
          `🔑 Found 'vault_password_file' and 'vault_identity_list' within '${cfgPath}', add 'default' to vault id list`
        );
        const vaultIdList = getVaultIdList(cfg.defaults.vault_identity_list);
        if (!vaultIdList.includes("default")) {
          vaultIdList.push("default");
        }
        return [
          cfgPath,
          vaultIdList,
          getVaultIdPasswordDict(cfg.defaults.vault_identity_list),
        ];
      }
      if (cfg.defaults.vault_password_file) {
        logs.appendLine(`🔑 Found 'vault_password_file' within '${cfgPath}'`);
        logs.appendLine(`▶️ Processing '${cfg.defaults.vault_password_file}'`);
        return [cfgPath, false, { default: cfg.defaults.vault_password_file }];
      }
      if (cfg.defaults.vault_identity_list) {
        logs.appendLine(`🔑 Found 'vault_identity_list' within '${cfgPath}'`);
        logs.appendLine(`▶️ Processing '${cfg.defaults.vault_identity_list}'`);
        const vaultIdList = getVaultIdList(cfg.defaults.vault_identity_list);
        return [
          cfgPath,
          vaultIdList,
          getVaultIdPasswordDict(cfg.defaults.vault_identity_list),
        ];
      }
    }
  }

  logs.appendLine(
    `✖️ Found no 'defaults.vault_password_file' or 'defaults.vault_identity_list' within config files`
  );
  return ["", false, false];
}

export function findPassword(
  logs: vscode.OutputChannel,
  configFileInWorkspacePath: string,
  vaultPassFile: string
) {
  if (fs.existsSync(vaultPassFile)) {
    const content = fs.readFileSync(vaultPassFile, "utf-8");
    return content.replace(/[\n\r\t]/gm, "");
  }
  const passPath = findAnsibleCfgFile(
    logs,
    configFileInWorkspacePath,
    vaultPassFile.trim()
  );
  return readFile(logs, passPath);
}

export function readFile(logs: vscode.OutputChannel, path: string | undefined) {
  if (path && fs.existsSync(path)) {
    return fs.readFileSync(path, "utf-8");
  }
  return undefined;
}

const getValueByCfg = (logs: vscode.OutputChannel, path: string) => {
  logs.appendLine(`📎 Reading '${path}'`);
  if (fs.existsSync(path)) {
    return ini.parse(fs.readFileSync(path, "utf-8"));
  }
  return undefined;
};

export function getVaultIdList(idList: string): string[] {
  return idList.split(",").map((element) => element.trim().split("@")[0]);
}

export function getVaultIdPasswordDict(idList: string): {
  [key: string]: string;
} {
  const vaultIdPasswordDict: { [key: string]: string } = {};
  idList.split(",").forEach((element) => {
    const [vaultName, passwordPath] = element.trim().split("@");
    vaultIdPasswordDict[vaultName.trim()] = passwordPath.trim();
  });
  return vaultIdPasswordDict;
}
