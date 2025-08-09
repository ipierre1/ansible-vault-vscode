## [1.1.0](https://github.com/ipierre1/ansible-vault-vscode/compare/v1.0.12...v1.1.0) (2025-08-09)

### CI/CD

* upgrade packages and fix lint issues ([4a54c99](https://github.com/ipierre1/ansible-vault-vscode/commit/4a54c9987f8a2f57338b7b46c90ad134b9795595))

### Features

* migrate eslint ([6f8619e](https://github.com/ipierre1/ansible-vault-vscode/commit/6f8619e69b06598b2a4b4309ed0f0a78be7dc581))

### Bug Fixes

* vscode engine version and action for protected branches ([57a15c6](https://github.com/ipierre1/ansible-vault-vscode/commit/57a15c67fd8b1098127bb27cbb64155433ac2b57))

## [1.0.10] - 2024-07-28

### Fix

- VS Code config over Ansible config.

## [1.0.9] - 2024-04-29

### Feat

- Prompt when vault password file not found.
- Use Ansible official reindent function for encrypted multilines vaults.
  
## [1.0.8] - 2024-04-13

### Bump

- NPM dependencies.

## [1.0.7] - 2024-03-27

### Fix

- Codelens do not select write codeblock. Add indentation search and verify.
- No password use case, if no password is find just return error.

## [1.0.6] - 2024-03-24

### Feat

- Rekey feature
- Codelens when text is encrypted to propose decrypt and rekey feature to user.

## [1.0.5] - 2024-03-23

### Fixed

- Vault ID List with password search.
- `ansible.cfg` configuration file search from opened document and not from root workspace.

### Feat

- Encrypt and decrypt from files explorer.
- Improve documentation.
- Remove deprecated extension recommendation and add ESLint and Prettier.

## [1.0.4] - 2024-03-22

### Feat

- Vault ID List with password search.

## [1.0.3] - 2024-03-18

### Fixed

- Missing regex on inline and downgrade VS Code version.

## [1.0.2] - 2024-03-18

### Fixed

- Missing `!vault |` on inline.

## [1.0.0] - 2024-03-15

### Added

- Initial release
