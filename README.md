# Ansible Vault inlines and files

## Overview

The Ansible Vault VS Code Extension is a tool designed to streamline the encryption and decryption of Ansible Vault files within the Visual Studio Code environment. With this extension, users can easily encrypt and decrypt text selections or entire files, manage vault identities, and configure encryption settings directly within VS Code.

## Features

- **Toggle Encryption/Decryption**: Quickly encrypt or decrypt selected text or entire files with a single command.
- **Automatic Vault Configuration**: Automatically detects and uses Ansible configuration settings (e.g., vault password file, vault identity list) from `ansible.cfg`.
- **Custom Vault Configuration**: Allows users to specify custom vault settings directly in VS Code configuration.
- **Manage Vault Identities**: Choose and manage vault identities for encryption and decryption.

## Usage

1. Open a file in Visual Studio Code.
2. Select the text you want to encrypt or decrypt, or leave it blank to encrypt/decrypt the entire file.
3. Use the available commands in the command palette or toolbar to perform encryption or decryption.

## Requirements

- Visual Studio Code

## Installation

1. Open Visual Studio Code.
2. Go to the Extensions view (`Ctrl+Shift+X`).
3. Search for "Ansible Vault" and install the extension.

## Configuration

The extension supports the following configuration options, which can be set in the VS Code settings:

- `ansibleVault.keyfile`: Path to the Ansible Vault password file.
- `ansibleVault.keypass`: Ansible Vault password (if not specified in `ansibleVault.keyfile`).
- `ansibleVault.encryptVaultId`: Default vault ID to use for encryption.

## Informations

This extension was forked from [Wolfmah / vscode-ansible-vault-inline](https://gitlab.com/wolfmah/vscode-ansible-vault-inline)

## License

This project is licensed under the MIT License - see the [LICENSE.md](https://gitlab.com/wolfmah/vscode-ansible-vault/-/blob/HEAD/LICENSE.md) file for details.
