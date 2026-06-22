# Git Diff Viewer

A Visual Studio Code extension that lets you inspect Git diffs directly from the sidebar and copy the currently selected diff output.

## Features

- **Diff Modes**: Switch between **All changes**, **Staged only**, and **Unstaged only** from the sidebar header.
- **Sidebar View**: View your current workspace diff in the VS Code sidebar without mutating the Git index.
- **Syntax Highlighting**: Basic syntax highlighting for diff outputs, separating additions, deletions, and hunks.
- **Copy Button**: Copy the raw diff output for the currently selected mode.
- **Stats**: View a quick summary of files changed, additions, and deletions.

## Usage

1. Open a workspace with a Git repository.
2. Click on the Git Diff Viewer icon in the Activity Bar to open the sidebar.
3. Choose one of the available diff modes:
   - **All changes**: staged + unstaged tracked changes, plus untracked files.
   - **Staged only**: only staged changes.
   - **Unstaged only**: only unstaged tracked changes.
4. Click **Reload** or switch modes to load the selected diff immediately.
5. Click **Copy** to copy the raw diff for the current mode.

## Requirements

- VS Code version `1.85.0` or higher.
- A valid Git installation available in the environment.

## Extension Settings

This extension does not contribute any configuration settings.

## Notes

This was made entirely for personal use.
