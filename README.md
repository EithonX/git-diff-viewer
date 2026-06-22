# Git Diff Viewer

A Visual Studio Code extension that lets you inspect Git diffs directly from the sidebar and copy the selected raw diff output.

## Features

- **Diff Modes**: Switch between **All changes**, **Staged only**, and **Unstaged only** from the sidebar header.
- **Changed Files Checklist**: Choose exactly which files are included in your diff using the interactive file checklist.
- **Copy Selected**: Copy the raw Git diff for exactly the files you checked.
- **Copy Current File**: Instantly copy the raw Git diff of your currently active file editor.
- **Large Diff Warning**: Protects your clipboard by warning you before copying diffs larger than 500 KB.
- **Raw Git Diff Output**: The copied output is pure raw Git diff only.
- **Sidebar View**: View your current workspace diff with syntax highlighting in the VS Code sidebar without mutating the Git index.
- **Stats**: View a quick summary of files changed, additions, and deletions.

## Usage

1. Open a workspace with a Git repository.
2. Click on the Git Diff Viewer icon in the Activity Bar to open the sidebar.
3. Choose one of the available diff modes:
   - **All changes**: staged + unstaged tracked changes, plus untracked files.
   - **Staged only**: only staged changes.
   - **Unstaged only**: only unstaged tracked changes.
4. Use the **Changed files** checklist to select or unselect files.
5. Click **Copy Selected** to copy the raw diff for the checked files.
6. Alternatively, click **Current File** to copy the diff of the file currently active in your editor.

## Requirements

- VS Code version `1.85.0` or higher.
- A valid Git installation available in the environment.

## Extension Settings

This extension does not contribute any configuration settings.

## Notes

This was made entirely for personal use.
