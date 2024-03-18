import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import untildify from "untildify";
import * as ini from "ini";

export function getRootPath(logs: vscode.OutputChannel, editorDocumentUri: vscode.Uri) {
    let rootPath: string | undefined = undefined;

    if (vscode.workspace.workspaceFolders) {
        rootPath = vscode.workspace.workspaceFolders.length
            ? vscode.workspace.workspaceFolders[0].name
            : undefined;
    }

    if (vscode.workspace.getWorkspaceFolder) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(editorDocumentUri);

        if (workspaceFolder) {
            rootPath = workspaceFolder.uri.path;
        } else {
            rootPath = undefined;
        }
    }

    return rootPath;
}

export function findAnsibleCfgFile(logs: vscode.OutputChannel, startPath: any = undefined): string | undefined {
    if (!fs.existsSync(startPath)) {
        logs.appendLine(`no dir ${startPath}`);
        return undefined;
    }

    const files = fs.readdirSync(startPath);
    for (let i = 0; i < files.length; i++) {
        const filename = path.join(startPath, files[i]);
        const stat = fs.lstatSync(filename);
        if (stat.isDirectory()) {
            const foundInSubdirectory = findAnsibleCfgFile(logs, filename);
            if (foundInSubdirectory) {
                return foundInSubdirectory;
            }
        } else if (filename.endsWith('ansible.cfg')) {
            return filename;
        }
    }
    return undefined;
}

export function scanAnsibleCfg(logs: vscode.OutputChannel, otherPath: any = undefined, rootPath: any = undefined) {
    
    const cfgFiles = [`~/.ansible.cfg`, `/etc/ansible.cfg`];
    
    if (rootPath) {
        cfgFiles.unshift(`${rootPath}/ansible.cfg`);
    }
    
    // WIP
    // if (otherPath) {
    //     cfgFiles.unshift(`${otherPath}`);
    // }
    
    if (process.env.ANSIBLE_CONFIG) {
        cfgFiles.unshift(process.env.ANSIBLE_CONFIG);
    }
    
    let result: [string, false | Array<string>] = ["", false];
    logs.appendLine(`Info (${otherPath})`);
    
    for (let i = 0; i < cfgFiles.length; i++) {
        const cfgFile = cfgFiles[i];
        logs.appendLine(`util.scanAnsibleCfg(${cfgFile})`);
        const cfgPath = untildify(cfgFile);

        const cfg = getValueByCfg(logs, cfgPath);
        if (!!cfg && !!cfg.defaults) {
            if (!!cfg.defaults.vault_password_file && !!cfg.defaults.vault_identity_list) {
                logs.appendLine(`Found 'vault_password_file' and 'vault_identity_list' within '${cfgPath}', add 'default' to vault id list`);
                const vaultIdList = getVaultIdList(cfg.defaults.vault_identity_list);
                if (!vaultIdList.includes("default")) {
                    vaultIdList.push("default");
                }
                result = [cfgPath, vaultIdList];
                return result;
            }
            if (cfg.defaults.vault_password_file) {
                logs.appendLine(`Found 'vault_password_file' within '${cfgPath}'`);
                result = [cfgPath, false];
                return result;
            }
            if (cfg.defaults.vault_identity_list) {
                logs.appendLine(`Found 'vault_identity_list' within '${cfgPath}'`);
                const vaultIdList = getVaultIdList(cfg.defaults.vault_identity_list);
                result = [cfgPath, vaultIdList];
                return result;
            }
        }
    }

    logs.appendLine(`Found no 'defaults.vault_password_file' or 'defaults.vault_identity_list' within config files`);
    return result;
}

const getValueByCfg = (logs: vscode.OutputChannel, path: any) => {
    logs.appendLine(`Reading '${path}'...`);

    if (fs.existsSync(path)) {
        return ini.parse(fs.readFileSync(path, "utf-8"));
    }

    return undefined;
};

export function getVaultIdList(idlist: string) {
    return idlist.split(",").map((element) => {
        return element.trim().split("@")[0];
    });
}
