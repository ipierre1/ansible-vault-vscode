import * as vscode from "vscode";
import * as util from "./util";
import { Vault } from "ansible-vault";

const logs = vscode.window.createOutputChannel("Ansible Vault");

// Cache for passwords during a session
interface PasswordCache {
  [key: string]: string;
}

// Global password cache
const passwordCache: PasswordCache = {};

class VaultedLineCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
    const codeLenses: vscode.CodeLens[] = [];
    
    // Find all vault encrypted content in the document
    const vaultRanges = findAllVaultRanges(document);
    
    for (const range of vaultRanges) {
      // Add decrypt action
      const decryptAction = new vscode.CodeLens(range, {
        title: "Decrypt",
        command: "extension.decryptVaultedLine",
        arguments: [document.uri, range.start.line, false],
      });
      
      // Add rekey action
      const rekeyAction = new vscode.CodeLens(range, {
        title: "Rekey",
        command: "extension.decryptVaultedLine",
        arguments: [document.uri, range.start.line, true],
      });
      
      codeLenses.push(decryptAction, rekeyAction);
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

/**
 * Find all vault encrypted ranges in a document
 */
function findAllVaultRanges(document: vscode.TextDocument): vscode.Range[] {
  const ranges: vscode.Range[] = [];
  const text = document.getText();
  
  // Find all !vault | indicators
  let lineIndex = 0;
  for (let line = 0; line < document.lineCount; line++) {
    const lineText = document.lineAt(line).text;
    
    // Check for vault indicators
    if (lineText.includes("!vault |") || lineText.startsWith("$ANSIBLE_VAULT;")) {
      let vaultStart = line;
      let vaultEnd = line;
      
      // For inline vault, find the end of the indented block
      if (lineText.includes("!vault |")) {
        const indentMatch = lineText.match(/^(\s*)/);
        const baseIndent = indentMatch ? indentMatch[1].length : 0;
        
        // Look for the end of the indented block
        let currentLine = line + 1;
        while (currentLine < document.lineCount) {
          const nextLineText = document.lineAt(currentLine).text;
          const nextIndentMatch = nextLineText.match(/^(\s*)/);
          const nextIndent = nextIndentMatch ? nextIndentMatch[1].length : 0;
          
          // If this line has less indent than our vault block, we've reached the end
          if (nextLineText.trim() !== "" && nextIndent <= baseIndent) {
            break;
          }
          
          vaultEnd = currentLine;
          currentLine++;
        }
      } 
      // For file vault format, look for end of encrypted block
      else if (lineText.startsWith("$ANSIBLE_VAULT;")) {
        // Find the end of the encrypted block (either end of file or next non-hex content)
        let currentLine = line + 1;
        while (currentLine < document.lineCount) {
          const nextLineText = document.lineAt(currentLine).text.trim();
          // Check if the line contains only hexadecimal characters
          if (!/^[0-9a-fA-F]+$/.test(nextLineText) && nextLineText !== "") {
            break;
          }
          vaultEnd = currentLine;
          currentLine++;
        }
      }
      
      ranges.push(new vscode.Range(vaultStart, 0, vaultEnd, document.lineAt(vaultEnd).text.length));
      
      // Skip to end of this vault content to continue search
      line = vaultEnd;
    }
  }
  
  return ranges;
}

export function activate(context: vscode.ExtensionContext) {
  logs.appendLine(
    '🎉 Ansible Vault Extension activated!'
  );

  // Track rekey sessions
  let rekeySession = false;
  
  // Status bar item for encryption mode
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right, 
    100
  );
  statusBarItem.text = "$(lock) Vault";
  statusBarItem.tooltip = "Ansible Vault: Click to encrypt/decrypt selection";
  statusBarItem.command = "extension.ansibleVault";
  context.subscriptions.push(statusBarItem);
  statusBarItem.show();

  // Register status bar update event
  vscode.window.onDidChangeActiveTextEditor(updateStatusBar);
  
  function updateStatusBar() {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const document = editor.document;
      if (document.languageId === "yaml" || document.fileName.endsWith(".yml")) {
        statusBarItem.show();
      } else {
        statusBarItem.hide();
      }
    }
  }
  
  /**
   * Get the vault password, checking cache first, then config, then prompt
   */
  async function getVaultPassword(vaultId: string = "default"): Promise<string | undefined> {
    // Check the cache first
    if (passwordCache[vaultId]) {
      logs.appendLine(`🔑 Using cached password for vault ID: ${vaultId}`);
      return passwordCache[vaultId];
    }
    
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("No active editor found.");
      return undefined;
    }
    
    const config = vscode.workspace.getConfiguration("ansibleVault");
    let pass: string | undefined;
    
    // Try to get password from configuration
    const configFileInWorkspacePath = util.getWorkspacePath (
      logs,
      editor.document.uri
    );
    
    let otherPath = util.findFileUp(
      logs,
      editor.document.uri.fsPath,
      "ansible.cfg"
    );
    
    if (otherPath !== undefined) {
      otherPath = util.isValidAnsibleConfig(
        logs,
        editor.document.uri,
        otherPath
      );
    }
    
    let keyInCfg: string,
      vaultIds: false | Array<string>,
      vaultPass: false | { [key: string]: string };
    [keyInCfg, vaultIds, vaultPass] = util.scanAnsibleConfig(
      logs,
      otherPath,
      configFileInWorkspacePath
    );
    
    // Try to get password from config
    if (config.keyFile || config.keyPass) {
      let keypath = "";
      if (config.keyFile) {
        keypath = util.untildify(config.keyFile.trim());
        pass = util.getVaultPassword(logs, editor.document.uri.fsPath, keypath);
      }
      if (config.keyPass) {
        pass = config.keyPass;
      }
    }
    else if (keyInCfg && vaultPass) {
      vscode.window.showInformationMessage(
        `Getting vault keyFile from ${keyInCfg}`
      );
      
      if (vaultPass["default"] !== undefined) {
        pass = util.getVaultPassword(
          logs,
          editor.document.uri.fsPath,
          vaultPass["default"]
        );
      } else if (vaultPass[vaultId] !== undefined) {
        pass = util.getVaultPassword(
          logs,
          editor.document.uri.fsPath,
          vaultPass[vaultId]
        );
      }
    }
    
    // If we still don't have a password, prompt the user
    if (!pass) {
      pass = await vscode.window.showInputBox({
        prompt: `Enter ansible-vault password${vaultId !== "default" ? ` for ${vaultId}` : ""}:`,
        password: true
      });
    }
    
    // Cache the password for this session if we got one
    if (pass) {
      passwordCache[vaultId] = pass;
    }
    
    return pass;
  }

  const decryptCommand = vscode.commands.registerCommand(
    "extension.decryptVaultedLine",
    async (uri: vscode.Uri, line: number, rekey: boolean) => {
      try {
        if (rekey) {
          rekeySession = true;
        }
        
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showErrorMessage("No active editor found.");
          return;
        }
        
        const document = await vscode.workspace.openTextDocument(uri);
        const text = document.getText();
        const lineText = document.lineAt(line).text;
        
        // Find the full vault content
        const vaultRanges = findAllVaultRanges(document);
        const targetRange = vaultRanges.find(range => range.start.line <= line && range.end.line >= line);
        
        if (!targetRange) {
          vscode.window.showErrorMessage("Could not identify vault content for decryption.");
          return;
        }
        
        // Determine the vault ID
        const vaultContent = document.getText(targetRange);
        const vaultId = extractVaultId(vaultContent) || "default";
        
        // Get password
        const password = await getVaultPassword(vaultId);
        if (!password) {
          vscode.window.showErrorMessage("No password provided for decryption.");
          return;
        }
        
        editor.selection = new vscode.Selection(targetRange.start, targetRange.end);
        await encryptDecrypt();
      } catch (error: any) {
        vscode.window.showErrorMessage(`Error during decryption: ${error.message}`);
        logs.appendLine(`❌ Error during decryption: ${error.message}`);
      }
    }
  );

  const toggleEncrypt = async () => {
    logs.appendLine("🔐 Starting new encrypt or decrypt session.");
    await encryptDecrypt();
  };

  const toggleRekey = async () => {
    logs.appendLine("🔐 Starting new rekey session.");
    rekeySession = true;
    await encryptDecrypt();
  };

  const encryptDecrypt = async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("No active editor found.");
      return;
    }

    const selection = editor.selection;
    if (!selection) {
      vscode.window.showErrorMessage("No selection found.");
      return;
    }

    // Show progress notification for long operations
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: rekeySession ? "Rekeying Ansible Vault" : "Processing Ansible Vault",
      cancellable: false
    }, async (progress) => {
      progress.report({ increment: 0 });
      
      try {
        const text = editor.document.getText(selection);
        const type = getTextType(text);
        
        // Determine vault ID to use
        let vaultId: string;
        if (type === "encrypted") {
          vaultId = extractVaultId(text) || await determineVaultId();
        } else {
          vaultId = await determineVaultId();
        }
        
        // Get password
        const password = await getVaultPassword(vaultId);
        if (!password) {
          vscode.window.showErrorMessage("No password provided for operation.");
          return;
        }
        
        progress.report({ increment: 50 });
        
        // Handle the encrypt/decrypt operation
        if (type === "plaintext") {
          logs.appendLine(`🔒 Encrypting selected text with vault ID: ${vaultId}`);
          const encryptedText = await encrypt(text, password, vaultId);
          await editor.edit((editBuilder) => {
            editBuilder.replace(
              selection,
              selection.isEmpty 
                ? encryptedText  // For whole file encryption
                : reindentText(encryptedText, getIndentationLevel(editor, selection), Number(editor.options.tabSize))
            );
          });
          vscode.window.showInformationMessage(
            `Content encrypted${vaultId ? ` with vault ID: ${vaultId}` : ""}`
          );
        } else if (type === "encrypted") {
          logs.appendLine(`🔓 Decrypting selected text with vault ID: ${vaultId}`);
          let vaultText = text;
          // Clean up the vault text for decryption if it's inline format
          if (text.includes("!vault |")) {
            vaultText = text
              .replace("!vault |", "")
              .trim()
              .split("\n")
              .map(line => line.trim())
              .join("\n");
          }
          
          const decryptedText = await decrypt(vaultText, password, vaultId);
          if (decryptedText === undefined) {
            vscode.window.showErrorMessage(`Decryption failed: Invalid Vault or incorrect password`);
          } else {
            await editor.edit((editBuilder) => {
              editBuilder.replace(selection, decryptedText);
            });
            vscode.window.showInformationMessage("Content decrypted successfully");
          }
        }
        
        progress.report({ increment: 100 });
        
        // Handle rekey session
        if (rekeySession) {
          rekeySession = false;
          // Re-select the decrypted content
          await encryptDecrypt();
        }
      } catch (error: any) {
        vscode.window.showErrorMessage(`Operation failed: ${error.message}`);
        logs.appendLine(`❌ Operation failed: ${error.message}`);
      }
    });
  };

  /**
   * Determine which vault ID to use for the operation
   */
  async function determineVaultId(): Promise<string> {
    const config = vscode.workspace.getConfiguration("ansibleVault");
    const editor = vscode.window.activeTextEditor;
    
    if (!editor) {
      return "default";
    }
    
    // Try to get vault ID list
    const configFileInWorkspacePath = util.getWorkspacePath (
      logs,
      editor.document.uri
    );
    
    let otherPath = util.findFileUp(
      logs,
      editor.document.uri.fsPath,
      "ansible.cfg"
    );
    
    if (otherPath !== undefined) {
      otherPath = util.isValidAnsibleConfig(
        logs,
        editor.document.uri,
        otherPath
      );
    }
    
    let keyInCfg: string,
      vaultIds: false | Array<string>,
      vaultPass: false | { [key: string]: string };
    [keyInCfg, vaultIds, vaultPass] = util.scanAnsibleConfig(
      logs,
      otherPath,
      configFileInWorkspacePath
    );
    
    // If we have a configured vault ID and it's valid, use it
    if (config.encryptVaultId && (!vaultIds || vaultIds.includes(config.encryptVaultId))) {
      return config.encryptVaultId;
    }
    
    // If we have exactly one vault ID, use it
    if (vaultIds && vaultIds.length === 1) {
      return vaultIds[0];
    }
    
    // Otherwise, let the user choose
    if (vaultIds && vaultIds.length > 1) {
      const selection = await vscode.window.showQuickPick(vaultIds, {
        placeHolder: "Choose ansible vault ID for operation: ",
        canPickMany: false
      });
      
      return selection || "default";
    }
    
    return "default";
  }

  const selectVaultId = async () => {
    logs.appendLine("✏️ Setting default VaultID in settings");

    const editor = vscode.window.activeTextEditor;
    let configFileInWorkspacePath = undefined;
    let otherPath = undefined;
    
    if (editor) {
      configFileInWorkspacePath = util.getWorkspacePath (
        logs,
        editor.document.uri
      );
      otherPath = util.findFileUp(
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
    [keyInCfg, vaultIds, vaultPass] = util.scanAnsibleConfig(
      logs,
      otherPath,
      configFileInWorkspacePath
    );
    
    // Try to get vault list from workspace config
    if (!keyInCfg && !!config.keyFile && isVaultIdList(config.keyFile)) {
      vaultIds = util.getVaultIdList(config.keyFile);
    }
    
    if (!vaultIds || !vaultIds.length) {
      const manualId = await vscode.window.showInputBox({
        prompt: "No vault IDs found. Enter a vault ID manually:",
        placeHolder: "default"
      });
      
      if (manualId) {
        config.update("encryptVaultId", manualId, false);
        vscode.window.showInformationMessage(
          `Set default vault ID to '${manualId}'`
        );
      }
      return;
    }
    
    const selection = await vscode.window.showQuickPick(vaultIds, {
      placeHolder: "Choose ansible vault ID for encryption: ",
      canPickMany: false,
    });
    
    if (selection) {
      config.update("encryptVaultId", selection, false);
      vscode.window.showInformationMessage(
        `Set default vault ID to '${selection}'`
      );
    }
  };

  const clearVaultIdSelection = async () => {
    logs.appendLine(`🗑️ Clear 'encryptVaultId' setting`);
    const config = vscode.workspace.getConfiguration("ansibleVault");
    config.update("encryptVaultId", "", false);
    vscode.window.showInformationMessage(`Cleared default vault ID`);
  };
  
  const clearPasswordCache = async () => {
    logs.appendLine(`🗑️ Clearing password cache`);
    Object.keys(passwordCache).forEach(key => {
      delete passwordCache[key];
    });
    vscode.window.showInformationMessage(`Password cache cleared`);
  };

  // Register code lens provider
  const codeLensProvider = new VaultedLineCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { scheme: "file", pattern: "**/*.{yaml,yml}" },
      codeLensProvider
    )
  );

  // Register commands
  context.subscriptions.push(decryptCommand);
  
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "extension.ansibleVault",
      toggleEncrypt
    )
  );
  
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "extension.ansibleVault.rekey",
      toggleRekey
    )
  );
  
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "extension.ansibleVault.selectVaultId",
      selectVaultId
    )
  );
  
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "extension.ansibleVault.clearVaultIdSelection",
      clearVaultIdSelection
    )
  );
  
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "extension.ansibleVault.clearPasswordCache",
      clearPasswordCache
    )
  );
  
  // Show status bar on activation
  updateStatusBar();
}

export function deactivate() {
  // Clear password cache on deactivation
  Object.keys(passwordCache).forEach(key => {
    delete passwordCache[key];
  });
}

// Returns whether the selected text is encrypted or in plain text.
const getInlineTextType = (text: string) => {
  if (text.trim().startsWith("!vault |")) {
    text = text.replace("!vault |", "");
  }

  return text.trim().startsWith("$ANSIBLE_VAULT;") ? "encrypted" : "plaintext";
};

// Returns whether the file is encrypted or in plain text.
const getTextType = (text: string) => {
  return text.trim().startsWith("$ANSIBLE_VAULT;") || text.trim().startsWith("!vault |") 
    ? "encrypted" 
    : "plaintext";
};

const getIndentationLevel = (
  editor: vscode.TextEditor,
  selection: vscode.Selection
): number => {
  if (!editor.options.tabSize) {
    return 0;
  }
  const startLine = editor.document.lineAt(selection.start.line).text;
  const indentationMatches = startLine.match(/^\s*/);
  const leadingWhitespaces = indentationMatches?.[0]?.length || 0;
  return Math.floor(leadingWhitespaces / Number(editor.options.tabSize));
};

const reindentText = (
  text: string,
  indentationLevel: number,
  tabSize: number,
) => {
  // Separate the header line from the content
  const lines = text.split("\n");
  
  // For single line output, just return as is
  if (lines.length <= 1) {
    return text;
  }
  
  // For multi-line content, handle indentation
  const leadingSpacesCount = (indentationLevel + 1) * tabSize;
  const leadingWhitespaces = " ".repeat(leadingSpacesCount);
  
  // First line is the "!vault |" marker, rest needs indentation
  const [header, ...contentLines] = lines;
  const indentedContent = contentLines
    .map(line => line.trim() ? `${leadingWhitespaces}${line.trim()}` : "")
    .join("\n");
  
  return `${header}\n${indentedContent}`;
};

const encrypt = async (text: string, pass: string, encryptVaultId: string = ""): Promise<string> => {
  try {
    const vault = new Vault({ password: pass });
    const encryptedContent = await vault.encrypt(text, encryptVaultId);
    return <string>encryptedContent;
  } catch (error: any) {
    logs.appendLine(`❌ Encryption failed: ${error.message}`);
    throw new Error(`Encryption failed: ${error.message}`);
  }
};

const decrypt = async (text: string, pass: string, encryptVaultId: string = ""): Promise<string | undefined> => {
  try {
    const vault = new Vault({ password: pass });
    const decryptedContent = await vault.decrypt(text, encryptVaultId);
    return <string>decryptedContent;
  } catch (error: any) {
    logs.appendLine(`❌ Decryption failed: ${error.message}`);
    return undefined;
  }
};

const isVaultIdList = (string: string): boolean => {
  return string.includes("@");
};

const extractVaultId = (encryptedContent: string): string | undefined => {
  // Remove leading "!vault |" if present
  encryptedContent = encryptedContent
    .replace("!vault |", "")
    .trim();
  
  // Split by lines and get the first line
  const lines = encryptedContent.split(/\r?\n/);
  const header = lines[0].trim();
  
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