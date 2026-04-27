import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  extractVaultId,
  findAnsibleCfgFile,
  findPassword,
  getConfigFileInWorkspace,
  getInlineTextType,
  getTextType,
  getVaultIdList,
  getVaultIdPasswordDict,
  isVaultIdList,
  readFile,
  reindentText,
  scanAnsibleCfg,
  untildify,
  verifyAnsibleDirectory,
} from "../util";

// Minimal logs stub
const logs: vscode.OutputChannel = { appendLine: () => {} };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "avtest-"));
}

function writeAnsibleCfg(dir: string, content: string): string {
  const cfgPath = path.join(dir, "ansible.cfg");
  fs.writeFileSync(cfgPath, content, "utf-8");
  return cfgPath;
}

// ---------------------------------------------------------------------------
// getInlineTextType
// ---------------------------------------------------------------------------

describe("getInlineTextType", () => {
  it("detects encrypted inline vault block", () => {
    const text = "!vault |\n  $ANSIBLE_VAULT;1.1;AES256\n  abc123";
    expect(getInlineTextType(text)).toBe("encrypted");
  });

  it("detects encrypted inline vault with leading whitespace", () => {
    const text = "  !vault |\n  $ANSIBLE_VAULT;1.1;AES256\n  abc123";
    expect(getInlineTextType(text)).toBe("encrypted");
  });

  it("detects encrypted text without !vault tag", () => {
    const text = "$ANSIBLE_VAULT;1.1;AES256\nabc123";
    expect(getInlineTextType(text)).toBe("encrypted");
  });

  it("returns plaintext for regular text", () => {
    expect(getInlineTextType("my secret value")).toBe("plaintext");
  });

  it("returns plaintext for empty string", () => {
    expect(getInlineTextType("")).toBe("plaintext");
  });

  it("returns plaintext when $ANSIBLE_VAULT is not at the start", () => {
    expect(getInlineTextType("key: $ANSIBLE_VAULT;1.1;AES256")).toBe("plaintext");
  });
});

// ---------------------------------------------------------------------------
// getTextType
// ---------------------------------------------------------------------------

describe("getTextType", () => {
  it("detects encrypted file content", () => {
    expect(getTextType("$ANSIBLE_VAULT;1.1;AES256\nhexdata")).toBe("encrypted");
  });

  it("returns plaintext when $ANSIBLE_VAULT is not at position 0", () => {
    expect(getTextType("\n$ANSIBLE_VAULT;1.1;AES256\nhexdata")).toBe("plaintext");
    expect(getTextType(" $ANSIBLE_VAULT;1.1;AES256\nhexdata")).toBe("plaintext");
  });

  it("returns plaintext for regular YAML", () => {
    expect(getTextType("key: value\nother: thing")).toBe("plaintext");
  });

  it("works with single-line vault header (no newline)", () => {
    expect(getTextType("$ANSIBLE_VAULT;1.1;AES256")).toBe("encrypted");
  });
});

// ---------------------------------------------------------------------------
// extractVaultId
// ---------------------------------------------------------------------------

describe("extractVaultId", () => {
  it("extracts vault ID from a 4-part header", () => {
    const content = "$ANSIBLE_VAULT;1.1;AES256;myVaultId\nhexdata";
    expect(extractVaultId(content)).toBe("myVaultId");
  });

  it("returns undefined when header has no vault ID (3-part header)", () => {
    const content = "$ANSIBLE_VAULT;1.1;AES256\nhexdata";
    expect(extractVaultId(content)).toBeUndefined();
  });

  it("handles !vault | inline prefix", () => {
    const content = "!vault |\n  $ANSIBLE_VAULT;1.1;AES256;prodVaultId\n  hexdata";
    expect(extractVaultId(content)).toBe("prodVaultId");
  });

  it("strips leading whitespace before checking header", () => {
    const content = "  $ANSIBLE_VAULT;1.1;AES256;devId\n  hexdata";
    expect(extractVaultId(content)).toBe("devId");
  });

  it("returns undefined for non-vault content", () => {
    expect(extractVaultId("not a vault")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isVaultIdList
// ---------------------------------------------------------------------------

describe("isVaultIdList", () => {
  it("returns true when value contains @", () => {
    expect(isVaultIdList("prod@/path/to/pass")).toBe(true);
  });

  it("returns true for a multi-vault list", () => {
    expect(isVaultIdList("dev@/dev/pass, prod@/prod/pass")).toBe(true);
  });

  it("returns false for a simple file path", () => {
    expect(isVaultIdList("/path/to/pass")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isVaultIdList("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// untildify
// ---------------------------------------------------------------------------

describe("untildify", () => {
  it("expands ~ at start to home directory", () => {
    // normalize both sides: untildify keeps the original separator after ~
    expect(path.normalize(untildify("~/myfile"))).toBe(path.join(os.homedir(), "myfile"));
  });

  it("expands bare ~ to home directory", () => {
    expect(path.normalize(untildify("~"))).toBe(path.normalize(os.homedir()));
  });

  it("does not expand ~ in the middle of a path", () => {
    expect(untildify("/some/~/path")).toBe("/some/~/path");
  });

  it("does not expand ~suffix (no separator after tilde)", () => {
    expect(untildify("~suffix")).toBe("~suffix");
  });

  it("does not modify absolute paths", () => {
    expect(untildify("/absolute/path")).toBe("/absolute/path");
  });

  it("throws TypeError for non-string input", () => {
    expect(() => untildify(123 as unknown as string)).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// getVaultIdList
// ---------------------------------------------------------------------------

describe("getVaultIdList", () => {
  it("parses a single vault ID", () => {
    expect(getVaultIdList("prod@/path/to/pass")).toEqual(["prod"]);
  });

  it("parses multiple vault IDs", () => {
    expect(getVaultIdList("dev@/dev/pass, prod@/prod/pass")).toEqual(["dev", "prod"]);
  });

  it("trims surrounding whitespace from each ID", () => {
    expect(getVaultIdList(" dev@/dev/pass , prod@/prod/pass ")).toEqual(["dev", "prod"]);
  });

  it("returns the raw string when no @ is present (no vault ID prefix)", () => {
    expect(getVaultIdList("default")).toEqual(["default"]);
  });
});

// ---------------------------------------------------------------------------
// getVaultIdPasswordDict
// ---------------------------------------------------------------------------

describe("getVaultIdPasswordDict", () => {
  it("parses a single vault ID to password path", () => {
    expect(getVaultIdPasswordDict("prod@/path/to/pass")).toEqual({
      prod: "/path/to/pass",
    });
  });

  it("parses multiple vault IDs", () => {
    expect(getVaultIdPasswordDict("dev@/dev/pass, prod@/prod/pass")).toEqual({
      dev: "/dev/pass",
      prod: "/prod/pass",
    });
  });

  it("trims whitespace around vault name and path", () => {
    expect(getVaultIdPasswordDict(" dev @ /dev/pass ")).toEqual({
      dev: "/dev/pass",
    });
  });
});

// ---------------------------------------------------------------------------
// reindentText
// ---------------------------------------------------------------------------

describe("reindentText", () => {
  it("wraps multi-line text in !vault | with correct indentation", () => {
    const result = reindentText("line1\nline2", 0, 2);
    expect(result).toBe("!vault |\n  line1\n  line2");
  });

  it("increases indentation level by 1", () => {
    const result = reindentText("line1\nline2", 1, 2);
    expect(result).toBe("!vault |\n    line1\n    line2");
  });

  it("returns single-line text unchanged", () => {
    expect(reindentText("singleline", 0, 2)).toBe("singleline");
  });

  it("strips trailing empty lines before indenting", () => {
    const result = reindentText("line1\nline2\n\n", 0, 2);
    expect(result).toBe("!vault |\n  line1\n  line2");
  });

  it("handles tab size of 4", () => {
    const result = reindentText("a\nb", 0, 4);
    expect(result).toBe("!vault |\n    a\n    b");
  });

  it("handles deeply nested indentation", () => {
    const result = reindentText("a\nb", 2, 2);
    // (2+1)*2 = 6 spaces
    expect(result).toBe("!vault |\n      a\n      b");
  });
});

// ---------------------------------------------------------------------------
// verifyAnsibleDirectory
// ---------------------------------------------------------------------------

describe("verifyAnsibleDirectory", () => {
  it("returns the config path when the document is inside the config directory", () => {
    const docUri = new vscode.Uri(path.join("/workspace", "ansible", "secrets.yml"));
    const cfgPath = path.join("/workspace", "ansible", "ansible.cfg");
    expect(verifyAnsibleDirectory(docUri, cfgPath)).toBe(cfgPath);
  });

  it("returns the config path when the document is in a subdirectory", () => {
    const docUri = new vscode.Uri(
      path.join("/workspace", "ansible", "group_vars", "secrets.yml"),
    );
    const cfgPath = path.join("/workspace", "ansible", "ansible.cfg");
    expect(verifyAnsibleDirectory(docUri, cfgPath)).toBe(cfgPath);
  });

  it("returns undefined when the document is outside the config directory", () => {
    const docUri = new vscode.Uri(path.join("/other", "project", "file.yml"));
    const cfgPath = path.join("/workspace", "ansible", "ansible.cfg");
    expect(verifyAnsibleDirectory(docUri, cfgPath)).toBeUndefined();
  });

  it("returns undefined when config dir is a sibling, not a parent", () => {
    const docUri = new vscode.Uri(path.join("/workspace", "other", "file.yml"));
    const cfgPath = path.join("/workspace", "ansible", "ansible.cfg");
    expect(verifyAnsibleDirectory(docUri, cfgPath)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getConfigFileInWorkspace
// ---------------------------------------------------------------------------

describe("getConfigFileInWorkspace", () => {
  const docUri = new vscode.Uri("/workspace/project/file.yml");

  beforeEach(() => {
    vscode.workspace.workspaceFolders = undefined;
    vscode.workspace.getWorkspaceFolder = () => undefined;
  });

  it("returns the workspace folder that owns the document", () => {
    const folder = { uri: { fsPath: "/workspace/project" } };
    vscode.workspace.getWorkspaceFolder = () => folder;
    expect(getConfigFileInWorkspace(docUri)).toBe("/workspace/project");
  });

  it("falls back to the first workspace folder when document has no folder", () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: "/workspace/first" } }];
    vscode.workspace.getWorkspaceFolder = () => undefined;
    expect(getConfigFileInWorkspace(docUri)).toBe("/workspace/first");
  });

  it("returns undefined when there are no workspace folders", () => {
    vscode.workspace.workspaceFolders = undefined;
    vscode.workspace.getWorkspaceFolder = () => undefined;
    expect(getConfigFileInWorkspace(docUri)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// readFile
// ---------------------------------------------------------------------------

describe("readFile", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("reads an existing file", () => {
    const filePath = path.join(tmpDir, "pass.txt");
    fs.writeFileSync(filePath, "mypassword", "utf-8");
    expect(readFile(filePath)).toBe("mypassword");
  });

  it("returns undefined for a non-existent file", () => {
    expect(readFile(path.join(tmpDir, "missing.txt"))).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(readFile(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findAnsibleCfgFile
// ---------------------------------------------------------------------------

describe("findAnsibleCfgFile", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("finds ansible.cfg by walking up from a nested file", () => {
    const cfgPath = writeAnsibleCfg(tmpDir, "[defaults]\n");
    const nested = path.join(tmpDir, "group_vars", "nested");
    fs.mkdirSync(nested, { recursive: true });
    const file = path.join(nested, "secrets.yml");
    fs.writeFileSync(file, "", "utf-8");

    expect(findAnsibleCfgFile(logs, file, "ansible.cfg")).toBe(cfgPath);
  });

  it("finds ansible.cfg starting from a directory path", () => {
    const cfgPath = writeAnsibleCfg(tmpDir, "[defaults]\n");
    const subdir = path.join(tmpDir, "roles");
    fs.mkdirSync(subdir);

    expect(findAnsibleCfgFile(logs, subdir, "ansible.cfg")).toBe(cfgPath);
  });

  it("returns undefined when no ansible.cfg exists in the tree", () => {
    const isolated = makeTmpDir();
    try {
      const result = findAnsibleCfgFile(logs, isolated, "ansible.cfg");
      expect(result).toBeUndefined();
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("returns undefined for undefined startPath", () => {
    expect(findAnsibleCfgFile(logs, undefined, "ansible.cfg")).toBeUndefined();
  });

  it("returns undefined for undefined needle", () => {
    expect(findAnsibleCfgFile(logs, tmpDir, undefined)).toBeUndefined();
  });

  it("returns undefined for a non-existent start path", () => {
    expect(
      findAnsibleCfgFile(logs, path.join(tmpDir, "nonexistent"), "ansible.cfg"),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findPassword
// ---------------------------------------------------------------------------

describe("findPassword", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("reads and trims a password from an absolute path", () => {
    const passFile = path.join(tmpDir, ".vault_pass");
    fs.writeFileSync(passFile, "mysecret\n", "utf-8");
    expect(findPassword(logs, tmpDir, passFile)).toBe("mysecret");
  });

  it("trims whitespace from all sides", () => {
    const passFile = path.join(tmpDir, ".vault_pass");
    fs.writeFileSync(passFile, "  mysecret  \n", "utf-8");
    expect(findPassword(logs, tmpDir, passFile)).toBe("mysecret");
  });

  it("returns undefined when the password file does not exist anywhere", () => {
    expect(findPassword(logs, tmpDir, "nonexistent_pass_file")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// scanAnsibleCfg
// ---------------------------------------------------------------------------

describe("scanAnsibleCfg", () => {
  let tmpDir: string;
  const savedAnsibleConfig = process.env.ANSIBLE_CONFIG;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    delete process.env.ANSIBLE_CONFIG;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedAnsibleConfig !== undefined) {
      process.env.ANSIBLE_CONFIG = savedAnsibleConfig;
    } else {
      delete process.env.ANSIBLE_CONFIG;
    }
  });

  it("returns empty result when no config files are found", () => {
    const [cfgPath, vaultIds, vaultPass] = scanAnsibleCfg(logs, undefined, tmpDir);
    expect(cfgPath).toBe("");
    expect(vaultIds).toBeUndefined();
    expect(vaultPass).toBeUndefined();
  });

  it("parses vault_password_file from ansible.cfg", () => {
    writeAnsibleCfg(tmpDir, "[defaults]\nvault_password_file = /path/to/.vault_pass\n");
    const [cfgPath, vaultIds, vaultPass] = scanAnsibleCfg(logs, undefined, tmpDir);

    expect(cfgPath).toContain("ansible.cfg");
    expect(vaultIds).toBeUndefined();
    expect(vaultPass).toEqual({ default: "/path/to/.vault_pass" });
  });

  it("parses vault_identity_list from ansible.cfg", () => {
    writeAnsibleCfg(
      tmpDir,
      "[defaults]\nvault_identity_list = dev@/dev/pass, prod@/prod/pass\n",
    );
    const [cfgPath, vaultIds, vaultPass] = scanAnsibleCfg(logs, undefined, tmpDir);

    expect(cfgPath).toContain("ansible.cfg");
    expect(vaultIds).toEqual(["dev", "prod"]);
    expect(vaultPass).toEqual({ dev: "/dev/pass", prod: "/prod/pass" });
  });

  it("adds 'default' to vault ID list when both keys are present", () => {
    writeAnsibleCfg(
      tmpDir,
      "[defaults]\nvault_password_file = /default/pass\nvault_identity_list = prod@/prod/pass\n",
    );
    const [, vaultIds] = scanAnsibleCfg(logs, undefined, tmpDir);
    expect(vaultIds).toContain("default");
    expect(vaultIds).toContain("prod");
  });

  it("does not duplicate 'default' when it is already in the identity list", () => {
    writeAnsibleCfg(
      tmpDir,
      "[defaults]\nvault_password_file = /default/pass\nvault_identity_list = default@/default/pass, prod@/prod/pass\n",
    );
    const [, vaultIds] = scanAnsibleCfg(logs, undefined, tmpDir);
    expect(vaultIds?.filter((id) => id === "default").length).toBe(1);
  });

  it("uses ANSIBLE_CONFIG env var with highest priority", () => {
    const envDir = makeTmpDir();
    try {
      writeAnsibleCfg(envDir, "[defaults]\nvault_password_file = /env/pass\n");
      writeAnsibleCfg(tmpDir, "[defaults]\nvault_password_file = /workspace/pass\n");
      process.env.ANSIBLE_CONFIG = path.join(envDir, "ansible.cfg");

      const [, , vaultPass] = scanAnsibleCfg(logs, undefined, tmpDir);
      expect(vaultPass).toEqual({ default: "/env/pass" });
    } finally {
      fs.rmSync(envDir, { recursive: true, force: true });
    }
  });

  it("uses directoryPath config over workspacePath config", () => {
    const workspaceDir = makeTmpDir();
    try {
      writeAnsibleCfg(workspaceDir, "[defaults]\nvault_password_file = /workspace/pass\n");
      writeAnsibleCfg(tmpDir, "[defaults]\nvault_password_file = /directory/pass\n");

      const [, , vaultPass] = scanAnsibleCfg(
        logs,
        path.join(tmpDir, "ansible.cfg"),
        workspaceDir,
      );
      expect(vaultPass).toEqual({ default: "/directory/pass" });
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
