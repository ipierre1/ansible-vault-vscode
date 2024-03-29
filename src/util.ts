import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as ini from "ini";
import * as os from 'os';

export function untildify(pathWithTilde: string) {
  const homeDirectory = os.homedir();
	if (typeof pathWithTilde !== 'string') {
		throw new TypeError(`Expected a string, got ${typeof pathWithTilde}`);
	}

	return homeDirectory ? pathWithTilde.replace(/^~(?=$|\/|\\)/, homeDirectory) : pathWithTilde;
}

export function getConfigFileInWorkspace(
  logs: vscode.OutputChannel,
  editorDocumentUri: vscode.Uri
) {
  let configFileInWorkspacePath: string | undefined = undefined;

  if (vscode.workspace.workspaceFolders) {
    configFileInWorkspacePath = vscode.workspace.workspaceFolders.length
      ? vscode.workspace.workspaceFolders[0].uri.fsPath
      : undefined;
  }

  if (vscode.workspace.getWorkspaceFolder) {
    const workspaceFolder =
      vscode.workspace.getWorkspaceFolder(editorDocumentUri);

    if (workspaceFolder) {
      configFileInWorkspacePath = workspaceFolder.uri.fsPath;
    } else {
      configFileInWorkspacePath = undefined;
    }
  }

  return configFileInWorkspacePath;
}

export function verifyAnsibleDirectory(
  logs: vscode.OutputChannel,
  editorDocumentUri: vscode.Uri,
  ansibleConfigPath: string
): string | undefined {
  const editorDocumentDir = path.dirname(editorDocumentUri.fsPath);
  const absoluteAnsibleConfigPath = path.dirname(ansibleConfigPath);
  // Check if the editor document directory is the same as the ansible config directory
  if (editorDocumentDir === absoluteAnsibleConfigPath) {
    return ansibleConfigPath;
  }
  // Check if the ansible config directory is a parent directory of the editor document directory
  if (editorDocumentDir.startsWith(absoluteAnsibleConfigPath + path.sep)) {
    return ansibleConfigPath;
  }
  // If none of the above conditions are met, return false
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

  // Normalize path for Windows
  startPath = path.normalize(startPath);

  // If startPath is a file, remove the file portion
  if (fs.lstatSync(startPath).isFile()) {
    startPath = path.dirname(startPath);
  }

  let currentDir = startPath;
  let foundPath: string | undefined;

  while (currentDir !== path.parse(currentDir).root) {
    const files = fs.readdirSync(currentDir);
    if (files.includes(needle || "")) {
      const filePath = path.join(currentDir, needle || "");
      if (fs.existsSync(filePath)) {
        foundPath = filePath;
        break;
      }
    }

    currentDir = path.dirname(currentDir);
  }

  return foundPath;
}

export function scanAnsibleCfg(
  logs: vscode.OutputChannel,
  configFileInDirectoryPath: any = undefined,
  configFileInWorkspacePath: any = undefined
) {
  let cfgFiles: string[] = [];

  if (process.platform !== "win32") {
      cfgFiles = ["~/.ansible.cfg", "/etc/ansible.cfg"];
  }

  if (configFileInWorkspacePath) {
    cfgFiles.unshift(`${configFileInWorkspacePath}${path.sep}ansible.cfg`);
  }

  if (configFileInDirectoryPath) {
    cfgFiles.unshift(`${configFileInDirectoryPath}`);
  }

  if (process.env.ANSIBLE_CONFIG) {
    cfgFiles.unshift(process.env.ANSIBLE_CONFIG);
  }

  let result: [
    string,
    false | Array<string>,
    false | { [key: string]: string }
  ] = ["", false, false];
  for (let i = 0; i < cfgFiles.length; i++) {
    const cfgFile = cfgFiles[i];
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
        result = [
          cfgPath,
          vaultIdList,
          getVaultIdPasswordDict(cfg.defaults.vault_identity_list),
        ];
        return result;
      }
      if (cfg.defaults.vault_password_file) {
        logs.appendLine(`🔑 Found 'vault_password_file' within '${cfgPath}'`);
        result = [
          cfgPath,
          false,
          { default: cfg.defaults.vault_password_file },
        ];
        return result;
      }
      if (cfg.defaults.vault_identity_list) {
        logs.appendLine(`🔑 Found 'vault_identity_list' within '${cfgPath}'`);
        const vaultIdList = getVaultIdList(cfg.defaults.vault_identity_list);
        result = [
          cfgPath,
          vaultIdList,
          getVaultIdPasswordDict(cfg.defaults.vault_identity_list),
        ];
        return result;
      }
    }
  }

  logs.appendLine(
    `✖️ Found no 'defaults.vault_password_file' or 'defaults.vault_identity_list' within config files`
  );
  return result;
}

export function findPassword(
  logs: vscode.OutputChannel,
  configFileInWorkspacePath: any,
  vaultPassFile: any
) {
  if (fs.existsSync(vaultPassFile)) {
    return fs.readFileSync(vaultPassFile, "utf-8");
  } else {
    const passPath = findAnsibleCfgFile(logs, configFileInWorkspacePath, vaultPassFile.trim());
    return readFile(logs, passPath);
  }
  return undefined;
}

export function readFile(logs: vscode.OutputChannel, path: any) {
  if (fs.existsSync(path)) {
    return fs.readFileSync(path, "utf-8");
  }
  return undefined;
}

const getValueByCfg = (logs: vscode.OutputChannel, path: any) => {
  logs.appendLine(`📎 Reading '${path}'`);

  if (fs.existsSync(path)) {
    return ini.parse(fs.readFileSync(path, "utf-8"));
  }

  return undefined;
};

export function getVaultIdList(idList: string) {
  return idList.split(",").map((element) => {
    return element.trim().split("@")[0];
  });
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
