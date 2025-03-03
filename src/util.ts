import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as ini from "ini";
import * as os from 'os';
import * as crypto from 'crypto';

// Cache for password storage during session
// This avoids prompting for the same password multiple times
const passwordCache: Map<string, string> = new Map();

/**
 * Convert a path with tilde to an absolute path
 * @param pathWithTilde - Path with potential tilde character
 * @returns Absolute path with tilde expanded
 */
export function untildify(pathWithTilde: string): string {
  if (typeof pathWithTilde !== 'string') {
    throw new TypeError(`Expected a string, got ${typeof pathWithTilde}`);
  }
  
  const homeDirectory = os.homedir();
  return homeDirectory ? pathWithTilde.replace(/^~(?=$|\/|\\)/, homeDirectory) : pathWithTilde;
}

/**
 * Get the workspace folder for a document
 * @param logs - Output channel for logging
 * @param documentUri - URI of the document
 * @returns Path to the workspace containing the document or undefined
 */
export function getWorkspacePath(
  logs: vscode.OutputChannel,
  documentUri: vscode.Uri
): string | undefined {
  try {
    // First try to get specific workspace folder for the file
    if (vscode.workspace.getWorkspaceFolder) {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
      if (workspaceFolder) {
        logs.appendLine(`📂 Found workspace folder: ${workspaceFolder.uri.fsPath}`);
        return workspaceFolder.uri.fsPath;
      }
    }
    
    // Fallback to first workspace folder
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      logs.appendLine(`📂 Using first workspace folder: ${vscode.workspace.workspaceFolders[0].uri.fsPath}`);
      return vscode.workspace.workspaceFolders[0].uri.fsPath;
    }
    
    logs.appendLine(`⚠️ No workspace folder found for ${documentUri.fsPath}`);
    return undefined;
  } catch (error) {
    logs.appendLine(`❌ Error finding workspace path: ${error}`);
    return undefined;
  }
}

/**
 * Check if an Ansible config file is valid for the current document
 * @param logs - Output channel for logging
 * @param documentUri - URI of the document
 * @param configPath - Path to the Ansible config file
 * @returns The config path if valid, undefined otherwise
 */
export function isValidAnsibleConfig(
  logs: vscode.OutputChannel,
  documentUri: vscode.Uri,
  configPath: string
): string | undefined {
  try {
    const documentDir = path.dirname(documentUri.fsPath);
    const configDir = path.dirname(configPath);
    
    // Config is valid if it's in the same directory or a parent directory
    if (documentDir === configDir || documentDir.startsWith(configDir + path.sep)) {
      logs.appendLine(`✅ Valid Ansible config: ${configPath}`);
      return configPath;
    }
    
    logs.appendLine(`❌ Invalid Ansible config path: ${configPath} is not a parent of ${documentUri.fsPath}`);
    return undefined;
  } catch (error) {
    logs.appendLine(`❌ Error validating Ansible config: ${error}`);
    return undefined;
  }
}

/**
 * Find a file by walking up the directory tree
 * @param logs - Output channel for logging
 * @param startPath - Starting path to search from
 * @param fileName - Name of the file to search for
 * @returns Path to the file if found, undefined otherwise
 */
export function findFileUp(
  logs: vscode.OutputChannel,
  startPath: string | undefined,
  fileName: string
): string | undefined {
  if (!startPath || !fs.existsSync(startPath)) {
    logs.appendLine(`❌ Invalid start path: ${startPath}`);
    return undefined;
  }

  try {
    // Normalize path for cross-platform compatibility
    startPath = path.normalize(startPath);

    // If startPath is a file, use its directory
    if (fs.statSync(startPath).isFile()) {
      startPath = path.dirname(startPath);
    }

    let currentDir = startPath;
    const rootDir = path.parse(currentDir).root;

    // Walk up the directory tree
    while (currentDir !== rootDir) {
      const candidatePath = path.join(currentDir, fileName);
      
      if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
        logs.appendLine(`🔍 Found file: ${candidatePath}`);
        return candidatePath;
      }

      // Move up one directory
      const parentDir = path.dirname(currentDir);
      
      // Break if we can't go up anymore
      if (parentDir === currentDir) {
        break;
      }
      
      currentDir = parentDir;
    }

    logs.appendLine(`⚠️ File not found: ${fileName}`);
    return undefined;
  } catch (error) {
    logs.appendLine(`❌ Error finding file: ${error}`);
    return undefined;
  }
}

/**
 * Interface for Ansible configuration
 */
interface AnsibleConfig {
  defaults?: {
    vault_password_file?: string;
    vault_identity_list?: string;
    [key: string]: any;
  };
  [section: string]: any;
}

/**
 * Interface for vault ID and password mapping
 */
interface VaultPasswordInfo {
  configPath: string;
  vaultIds: string[] | false;
  passwords: {[key: string]: string} | false;
}

/**
 * Scan for and parse Ansible configuration files
 * @param logs - Output channel for logging
 * @param configInDocDir - Path to config file in document directory
 * @param workspacePath - Path to workspace directory
 * @returns Information about vault ids and passwords
 */
export function scanAnsibleConfig(
  logs: vscode.OutputChannel,
  configInDocDir: string | undefined,
  workspacePath: string | undefined
): VaultPasswordInfo {
  // Default result with empty values
  const defaultResult: VaultPasswordInfo = {
    configPath: "",
    vaultIds: false,
    passwords: false
  };

  try {
    // Build list of possible config file locations in priority order
    let configPaths: string[] = [];

    // Environment variable has highest priority
    if (process.env.ANSIBLE_CONFIG) {
      configPaths.push(process.env.ANSIBLE_CONFIG);
    }

    // Then config in the document directory
    if (configInDocDir) {
      configPaths.push(configInDocDir);
    }

    // Then config in the workspace root
    if (workspacePath) {
      configPaths.push(path.join(workspacePath, 'ansible.cfg'));
    }

    // Then user and system-wide configs
    if (process.platform !== "win32") {
      configPaths.push(path.join(os.homedir(), '.ansible.cfg'));
      configPaths.push('/etc/ansible.cfg');
    } else {
      // Windows-specific paths
      if (process.env.APPDATA) {
        configPaths.push(path.join(process.env.APPDATA, 'ansible.cfg'));
      }
    }

    logs.appendLine(`🔍 Searching for Ansible config in: ${configPaths.join(', ')}`);

    // Process each config file in order until we find what we need
    for (const configPath of configPaths) {
      if (!fs.existsSync(configPath)) {
        continue;
      }

      logs.appendLine(`📄 Reading config file: ${configPath}`);
      const config = parseConfig(logs, configPath);
      
      if (!config || !config.defaults) {
        continue;
      }

      // Check for vault config properties
      const { vault_password_file, vault_identity_list } = config.defaults;

      // Both password file and identity list
      if (vault_password_file && vault_identity_list) {
        logs.appendLine(`🔑 Found both vault_password_file and vault_identity_list in ${configPath}`);
        const vaultIds = parseVaultIdList(vault_identity_list);
        
        // Add default to vault id list if not present
        if (!vaultIds.includes("default")) {
          vaultIds.push("default");
        }
        
        return {
          configPath,
          vaultIds,
          passwords: {
            ...parseVaultIdPasswordMapping(vault_identity_list),
            default: vault_password_file
          }
        };
      }
      
      // Just password file
      if (vault_password_file) {
        logs.appendLine(`🔑 Found vault_password_file in ${configPath}`);
        return {
          configPath,
          vaultIds: false,
          passwords: { default: vault_password_file }
        };
      }
      
      // Just identity list
      if (vault_identity_list) {
        logs.appendLine(`🔑 Found vault_identity_list in ${configPath}`);
        return {
          configPath,
          vaultIds: parseVaultIdList(vault_identity_list),
          passwords: parseVaultIdPasswordMapping(vault_identity_list)
        };
      }
    }

    logs.appendLine(`⚠️ No vault configuration found in any config file`);
    return defaultResult;
  } catch (error) {
    logs.appendLine(`❌ Error scanning Ansible config: ${error}`);
    return defaultResult;
  }
}

/**
 * Parse an Ansible configuration file
 * @param logs - Output channel for logging
 * @param configPath - Path to the config file
 * @returns Parsed config object or undefined on error
 */
function parseConfig(
  logs: vscode.OutputChannel, 
  configPath: string
): AnsibleConfig | undefined {
  try {
    const configContent = fs.readFileSync(configPath, 'utf-8');
    return ini.parse(configContent);
  } catch (error) {
    logs.appendLine(`❌ Error parsing config ${configPath}: ${error}`);
    return undefined;
  }
}

/**
 * Extract vault IDs from a vault identity list string
 * @param idList - Comma-separated list of vault identities
 * @returns Array of vault IDs
 */
export function parseVaultIdList(idList: string): string[] {
  return idList.split(',')
    .map(entry => entry.trim().split('@')[0].trim())
    .filter(id => id.length > 0);
}

/**
 * Create a mapping of vault IDs to password file paths
 * @param idList - Comma-separated list of vault identities
 * @returns Object mapping vault IDs to password file paths
 */
export function parseVaultIdPasswordMapping(idList: string): {[key: string]: string} {
  const mapping: {[key: string]: string} = {};
  
  idList.split(',').forEach(entry => {
    const parts = entry.trim().split('@');
    if (parts.length === 2) {
      mapping[parts[0].trim()] = parts[1].trim();
    }
  });
  
  return mapping;
}

/**
 * Create a secure key for password caching
 * @param vaultId - Vault ID
 * @param filePath - Path to the file being processed
 * @returns Secure cache key
 */
function createPasswordCacheKey(vaultId: string, filePath: string): string {
  return crypto.createHash('sha256')
    .update(`${vaultId}:${filePath}`)
    .digest('hex');
}

/**
 * Get password from cache or read from file
 * @param logs - Output channel for logging
 * @param filePath - Path to the file being processed
 * @param passwordPath - Path to the password file
 * @param vaultId - Vault ID (for caching)
 * @returns Password as string or undefined
 */
export async function getVaultPassword(
  logs: vscode.OutputChannel,
  filePath: string,
  passwordPath: string | undefined,
  vaultId: string = 'default'
): Promise<string | undefined> {
  // Create cache key
  const cacheKey = createPasswordCacheKey(vaultId, filePath);
  
  // Check cache first
  if (passwordCache.has(cacheKey)) {
    logs.appendLine(`🔐 Using cached password for vault ID: ${vaultId}`);
    return passwordCache.get(cacheKey);
  }
  
  // Try to read from password file
  if (passwordPath) {
    try {
      // First check if it's an absolute path
      let resolvedPath = passwordPath;
      
      // Expand tilde if present
      if (passwordPath.startsWith('~')) {
        resolvedPath = untildify(passwordPath);
      }
      
      // Check if the file exists at the direct path
      if (fs.existsSync(resolvedPath)) {
        logs.appendLine(`🔑 Reading password from file: ${resolvedPath}`);
        const password = fs.readFileSync(resolvedPath, 'utf-8').trim();
        
        // Cache the password
        passwordCache.set(cacheKey, password);
        return password;
      }
      
      // Try finding it relative to the current file
      const foundPath = findFileUp(logs, filePath, passwordPath);
      if (foundPath) {
        logs.appendLine(`🔑 Reading password from found file: ${foundPath}`);
        const password = fs.readFileSync(foundPath, 'utf-8').trim();
        
        // Cache the password
        passwordCache.set(cacheKey, password);
        return password;
      }
    } catch (error) {
      logs.appendLine(`❌ Error reading password file: ${error}`);
    }
  }
  
  // Ask user for password as a last resort
  logs.appendLine(`🔑 Prompting user for password for vault ID: ${vaultId}`);
  const password = await promptForPassword(vaultId);
  
  if (password) {
    // Cache the password
    passwordCache.set(cacheKey, password);
    return password;
  }
  
  return undefined;
}

/**
 * Prompt the user for a password
 * @param vaultId - Vault ID to include in the prompt
 * @returns User entered password or undefined
 */
async function promptForPassword(vaultId: string): Promise<string | undefined> {
  const prompt = vaultId === 'default' 
    ? 'Enter Ansible Vault password: '
    : `Enter Ansible Vault password for ID '${vaultId}': `;
    
  return vscode.window.showInputBox({
    prompt,
    password: true,
    placeHolder: 'Vault password',
    ignoreFocusOut: true // Prevent dialog from closing when focus is lost
  });
}

/**
 * Clear all cached passwords
 */
export function clearPasswordCache(): void {
  passwordCache.clear();
}

/**
 * Read text file contents
 * @param logs - Output channel for logging
 * @param filePath - Path to the file
 * @returns File contents as string or undefined
 */
export function readTextFile(logs: vscode.OutputChannel, filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8').trim();
    }
  } catch (error) {
    logs.appendLine(`❌ Error reading file ${filePath}: ${error}`);
  }
  
  return undefined;
}