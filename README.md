# Git Diff Viewer

A Visual Studio Code extension that allows you to load and view the `git diff` output directly from the sidebar. You can also easily copy the diff to your clipboard.

## Features

- **Sidebar View**: View your current workspace's `git diff HEAD` right in the VS Code sidebar.
- **Syntax Highlighting**: Basic syntax highlighting for diff outputs, separating additions, deletions, and hunks.
- **Copy Button**: A quick access button to copy the raw diff output to your clipboard.
- **Stats**: View a quick summary of files changed, additions, and deletions.

## Usage

1. Open a workspace with a Git repository.
2. Click on the Git Diff Viewer icon in the Activity Bar to open the sidebar.
3. Click the **Load** button to analyze your workspace. The output of `git diff HEAD` (or `git diff` if no HEAD is found) will be displayed.
4. Click the **Copy** button to copy the raw diff output.

## Requirements

- VS Code version `1.85.0` or higher.
- A valid Git installation available in the environment.

## Extension Settings

This extension does not contribute any configuration settings.

## Notes

This was made entirely for personal use.
