import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as ini from "ini";
import * as os from "os";

export const getInlineTextType = (text: string): "encrypted" | "plaintext" => {
  const normalized = text.trim().startsWith("!vault |")
    ? text.replace("!vault |", "")
    : text;
  return normalized.trim().startsWith("$ANSIBLE_VAULT;")
    ? "encrypted"
    : "plaintext";
};

export const getTextType = (text: string): "encrypted" | "plaintext" => {
  return text.startsWith("$ANSIBLE_VAULT;") ? "encrypted" : "plaintext";
};

export const extractVaultId = (
  encryptedContent: string,
): string | undefined => {
  const normalized = encryptedContent
    .replace("!vault |", "")
    .trim()
    .replace(/[^\S\r\n]+/gm, "");
  const [header] = normalized.split(/\r?\n/);
  if (header.startsWith("$ANSIBLE_VAULT")) {
    const parts = header.split(";");
    if (parts.length >= 4) {
      return parts[3];
    }
  }
  return undefined;
};

export const isVaultIdList = (value: string): boolean => value.includes("@");

export function untildify(pathWithTilde: string): string {
  if (typeof pathWithTilde !== "string") {
    throw new TypeError(`Expected a string, got ${typeof pathWithTilde}`);
  }
  const homeDirectory = os.homedir();
  return homeDirectory
    ? pathWithTilde.replace(/^~(?=$|\/|\\)/, homeDirectory)
    : pathWithTilde;
}

// In multi-root workspaces, prefer the workspace that owns the active document.
export function getConfigFileInWorkspace(
  editorDocumentUri: vscode.Uri,
): string | undefined {
  const workspaceFolder =
    vscode.workspace.getWorkspaceFolder(editorDocumentUri);
  if (workspaceFolder) {
    return workspaceFolder.uri.fsPath;
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function verifyAnsibleDirectory(
  editorDocumentUri: vscode.Uri,
  ansibleConfigPath: string,
): string | undefined {
  const editorDocumentDir = path.dirname(editorDocumentUri.fsPath);
  const configDir = path.dirname(ansibleConfigPath);
  if (
    editorDocumentDir === configDir ||
    editorDocumentDir.startsWith(configDir + path.sep)
  ) {
    return ansibleConfigPath;
  }
  return undefined;
}

export function findAnsibleCfgFile(
  logs: vscode.OutputChannel,
  startPath: string | undefined,
  needle: string | undefined,
): string | undefined {
  if (!startPath || !needle) {
    return undefined;
  }
  if (!fs.existsSync(startPath)) {
    logs.appendLine(`Invalid start path: ${startPath}`);
    return undefined;
  }

  let currentDir = path.normalize(startPath);
  if (fs.lstatSync(currentDir).isFile()) {
    currentDir = path.dirname(currentDir);
  }

  while (currentDir !== path.parse(currentDir).root) {
    const filePath = path.join(currentDir, needle);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
    currentDir = path.dirname(currentDir);
  }
  return undefined;
}

export function scanAnsibleCfg(
  logs: vscode.OutputChannel,
  configFileInDirectoryPath?: string,
  configFileInWorkspacePath?: string,
): [string, string[] | undefined, Record<string, string> | undefined] {
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
    if (cfg?.defaults) {
      const { vault_password_file, vault_identity_list } = cfg.defaults;
      if (vault_password_file && vault_identity_list) {
        logs.appendLine(
          `🔑 Found 'vault_password_file' and 'vault_identity_list' within '${cfgPath}', adding 'default' to vault id list`,
        );
        const vaultIdList = getVaultIdList(vault_identity_list);
        if (!vaultIdList.includes("default")) {
          vaultIdList.push("default");
        }
        return [
          cfgPath,
          vaultIdList,
          getVaultIdPasswordDict(vault_identity_list),
        ];
      }
      if (vault_password_file) {
        logs.appendLine(`🔑 Found 'vault_password_file' within '${cfgPath}'`);
        return [cfgPath, undefined, { default: vault_password_file }];
      }
      if (vault_identity_list) {
        logs.appendLine(`🔑 Found 'vault_identity_list' within '${cfgPath}'`);
        return [
          cfgPath,
          getVaultIdList(vault_identity_list),
          getVaultIdPasswordDict(vault_identity_list),
        ];
      }
    }
  }

  logs.appendLine(
    `✖️ No 'vault_password_file' or 'vault_identity_list' found in config files`,
  );
  return ["", undefined, undefined];
}

export function findPassword(
  logs: vscode.OutputChannel,
  configFileInWorkspacePath: string,
  vaultPassFile: string,
): string | undefined {
  if (fs.existsSync(vaultPassFile)) {
    return fs.readFileSync(vaultPassFile, "utf-8").trim();
  }
  const passPath = findAnsibleCfgFile(
    logs,
    configFileInWorkspacePath,
    vaultPassFile.trim(),
  );
  return readFile(passPath);
}

export function readFile(filePath: string | undefined): string | undefined {
  if (filePath && fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, "utf-8");
  }
  return undefined;
}

const getValueByCfg = (logs: vscode.OutputChannel, cfgPath: string) => {
  logs.appendLine(`📎 Reading '${cfgPath}'`);
  if (fs.existsSync(cfgPath)) {
    return ini.parse(fs.readFileSync(cfgPath, "utf-8"));
  }
  return undefined;
};

export function getVaultIdList(idList: string): string[] {
  return idList.split(",").map((element) => element.trim().split("@")[0]);
}

export function getVaultIdPasswordDict(idList: string): Record<string, string> {
  return Object.fromEntries(
    idList.split(",").map((element) => {
      const [vaultName, passwordPath] = element.trim().split("@");
      return [vaultName.trim(), passwordPath.trim()];
    }),
  );
}
