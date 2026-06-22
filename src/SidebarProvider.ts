import * as vscode from "vscode";
import { execFile } from "child_process";

type DiffMode = "all" | "staged" | "unstaged";

type GitCommandOptions = {
    allowExitCodes?: number[];
};

type GitCommandResult = {
    stdout: string;
    stderr: string;
    exitCode: number;
};

const MAX_GIT_BUFFER = 50 * 1024 * 1024;
class GitCommandError extends Error {
    constructor(
        readonly args: string[],
        readonly stdout: string,
        readonly stderr: string,
        readonly exitCode: number,
        message: string
    ) {
        super(message);
        this.name = "GitCommandError";
    }
}

function isDiffMode(value: unknown): value is DiffMode {
    return value === "all" || value === "staged" || value === "unstaged";
}

function isGitCommandError(error: unknown): error is GitCommandError {
    return error instanceof GitCommandError;
}

/**
 * Provides the webview content for the Git Diff Viewer sidebar.
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _latestDiff = "";
    private _isViewReady = false;
    private _selectedMode: DiffMode = "all";
    private _loadRequestId = 0;

    /**
     * Initializes the SidebarProvider.
     * @param _extensionUri The URI of the extension providing the webview.
     */
    constructor(private readonly _extensionUri: vscode.Uri) { }

    /**
     * Resolves the webview view. Called when the view first becomes visible.
     * @param webviewView The webview view to resolve.
     * @param _context Additional context.
     * @param _token A cancellation token.
     */
    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;
        this._isViewReady = false;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtml();

        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case "ready": {
                    if (isDiffMode(message.mode)) {
                        this._selectedMode = message.mode;
                    }

                    this._isViewReady = true;
                    if (webviewView.visible) {
                        void this._loadDiff(this._selectedMode);
                    }
                    break;
                }

                case "loadDiff": {
                    const mode = isDiffMode(message.mode) ? message.mode : this._selectedMode;
                    void this._loadDiff(mode);
                    break;
                }

                case "copyDiff": {
                    if (this._latestDiff) {
                        await vscode.env.clipboard.writeText(this._latestDiff);
                        vscode.window.showInformationMessage("Diff copied to clipboard!");
                    } else {
                        vscode.window.showWarningMessage("Load a diff before copying.");
                    }
                    break;
                }

                case "showError": {
                    vscode.window.showErrorMessage(message.data);
                    break;
                }
            }
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible && this._isViewReady) {
                void this._loadDiff(this._selectedMode);
            }
        });
    }

    private async _loadDiff(mode: DiffMode = this._selectedMode) {
        if (!this._view) {
            return;
        }

        this._selectedMode = mode;
        const requestId = ++this._loadRequestId;
        this._latestDiff = "";

        this._postIfLatest(requestId, {
            command: "loadingDiff",
            mode,
        });

        const workspaceFolder = this._getPreferredWorkspaceFolder();
        if (!workspaceFolder) {
            this._postIfLatest(requestId, {
                command: "diffResult",
                success: false,
                mode,
                data: "Open a workspace folder to load Git diff output.",
            });
            return;
        }

        const cwd = workspaceFolder.uri.fsPath;

        try {
            await this._ensureGitRepository(cwd);

            const diffText = await this._loadDiffText(mode, cwd);
            if (!this._isLatestRequest(requestId)) {
                return;
            }

            this._latestDiff = diffText;
            this._view.webview.postMessage({
                command: "diffResult",
                success: true,
                mode,
                data: diffText,
            });
        } catch (error) {
            if (!this._isLatestRequest(requestId)) {
                return;
            }

            this._latestDiff = "";
            this._view.webview.postMessage({
                command: "diffResult",
                success: false,
                mode,
                data: this._toFriendlyError(error),
            });
        }
    }

    private _getPreferredWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return undefined;
        }

        const activeDocument = vscode.window.activeTextEditor?.document;
        if (activeDocument?.uri.scheme === "file") {
            const activeFolder = vscode.workspace.getWorkspaceFolder(activeDocument.uri);
            if (activeFolder) {
                return activeFolder;
            }
        }

        return workspaceFolders[0];
    }

    private async _ensureGitRepository(cwd: string): Promise<void> {
        await this._runGit(["rev-parse", "--is-inside-work-tree"], cwd);
    }

    private async _loadDiffText(mode: DiffMode, cwd: string): Promise<string> {
        switch (mode) {
            case "staged":
                return this._loadStagedDiff(cwd);
            case "unstaged":
                return this._loadUnstagedDiff(cwd);
            case "all":
            default:
                return this._loadAllDiff(cwd);
        }
    }

    private async _loadStagedDiff(cwd: string): Promise<string> {
        const result = await this._runGit(
            ["diff", "--cached", "--no-ext-diff", "--no-color"],
            cwd
        );

        return result.stdout;
    }

    private async _loadUnstagedDiff(cwd: string): Promise<string> {
        const result = await this._runGit(
            ["diff", "--no-ext-diff", "--no-color"],
            cwd
        );

        return result.stdout;
    }

    private async _loadAllDiff(cwd: string): Promise<string> {
        let trackedDiff = "";

        try {
            const result = await this._runGit(
                ["diff", "--no-ext-diff", "--no-color", "HEAD"],
                cwd
            );
            trackedDiff = result.stdout;
        } catch (error) {
            if (!this._isMissingHeadError(error)) {
                throw error;
            }

            trackedDiff = this._joinDiffChunks([
                await this._loadStagedDiff(cwd),
                await this._loadUnstagedDiff(cwd),
            ]);
        }

        const untrackedDiff = await this._loadUntrackedDiff(cwd);
        return this._joinDiffChunks([trackedDiff, untrackedDiff]);
    }

    private async _loadUntrackedDiff(cwd: string): Promise<string> {
        const { stdout } = await this._runGit(
            ["ls-files", "--others", "--exclude-standard", "-z"],
            cwd
        );

        const files = stdout.split("\0").filter((file) => file.length > 0);
        if (files.length === 0) {
            return "";
        }

        const diffChunks: string[] = [];

        for (const file of files) {
            try {
                const diffResult = await this._runGit(
                    ["diff", "--no-index", "--no-ext-diff", "--no-color", "--", "/dev/null", file],
                    cwd,
                    { allowExitCodes: [1] }
                );
                diffChunks.push(diffResult.stdout);
            } catch (error) {
                if (this._isMissingUntrackedFileError(error)) {
                    continue;
                }

                throw error;
            }
        }

        return this._joinDiffChunks(diffChunks);
    }

    private _joinDiffChunks(chunks: string[]): string {
        const nonEmptyChunks = chunks.filter((chunk) => chunk.length > 0);
        if (nonEmptyChunks.length === 0) {
            return "";
        }

        let combined = nonEmptyChunks[0];
        for (const chunk of nonEmptyChunks.slice(1)) {
            if (!combined.endsWith("\n") && !chunk.startsWith("\n")) {
                combined += "\n";
            }
            combined += chunk;
        }

        return combined;
    }

    private _runGit(
        args: string[],
        cwd: string,
        options: GitCommandOptions = {}
    ): Promise<GitCommandResult> {
        const allowedExitCodes = new Set(options.allowExitCodes ?? []);

        return new Promise((resolve, reject) => {
            execFile(
                "git",
                args,
                {
                    cwd,
                    maxBuffer: MAX_GIT_BUFFER,
                    windowsHide: true,
                },
                (error, stdout, stderr) => {
                    const exitCode =
                        typeof error?.code === "number"
                            ? error.code
                            : error
                                ? 1
                                : 0;

                    if (error && !allowedExitCodes.has(exitCode)) {
                        reject(
                            new GitCommandError(
                                args,
                                stdout,
                                stderr,
                                exitCode,
                                stderr.trim() || error.message
                            )
                        );
                        return;
                    }

                    resolve({
                        stdout,
                        stderr,
                        exitCode,
                    });
                }
            );
        });
    }

    private _isMissingHeadError(error: unknown): boolean {
        if (!isGitCommandError(error)) {
            return false;
        }

        const message = `${error.stderr}\n${error.message}`.toLowerCase();
        return message.includes("ambiguous argument 'head'")
            || message.includes("bad revision 'head'")
            || message.includes("unknown revision or path not in the working tree");
    }

    private _isMissingUntrackedFileError(error: unknown): boolean {
        if (!isGitCommandError(error)) {
            return false;
        }

        const message = `${error.stderr}\n${error.message}`.toLowerCase();
        return message.includes("could not access")
            || message.includes("no such file or directory");
    }

    private _toFriendlyError(error: unknown): string {
        if (isGitCommandError(error)) {
            const message = `${error.stderr}\n${error.message}`.toLowerCase();

            if (message.includes("not a git repository")) {
                return "Selected folder is not a Git repository.";
            }

            if (message.includes("spawn git") && message.includes("enoent")) {
                return "Git executable not found in PATH.";
            }

            return error.stderr.trim() || error.message;
        }

        if (error instanceof Error) {
            return error.message;
        }

        return "Unknown error while loading diff.";
    }

    private _isLatestRequest(requestId: number): boolean {
        return requestId === this._loadRequestId;
    }

    private _postIfLatest(requestId: number, message: Record<string, unknown>) {
        if (!this._view || !this._isLatestRequest(requestId)) {
            return;
        }

        this._view.webview.postMessage(message);
    }

    private _getHtml(): string {
        return /*html*/ `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Git Diff Viewer</title>
  <link href="https://cdn.jsdelivr.net/npm/@vscode/codicons/dist/codicon.css" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; }

    body {
      margin: 0;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .header-container {
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      z-index: 10;
    }

    .header {
      padding: 12px 14px;
    }

    .header h2 {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--vscode-sideBarTitle-foreground);
      margin: 0 0 12px 0;
      display: flex;
      align-items: center;
      gap: 6px;
      letter-spacing: 0.5px;
    }

    .toolbar {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .mode-select {
      min-width: 116px;
      height: 30px;
      padding: 0 8px;
      border: 1px solid var(--vscode-dropdown-border, transparent);
      border-radius: 2px;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      font-family: inherit;
      font-size: 12px;
      outline: none;
    }

    .mode-select:focus {
      border-color: var(--vscode-focusBorder);
    }

    .btn-row {
      display: flex;
      gap: 8px;
      flex: 1;
    }

    .btn {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 6px 12px;
      border: 1px solid transparent;
      border-radius: 2px;
      font-family: inherit;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.1s;
      outline: none;
    }

    .btn:active { transform: translateY(1px); }

    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }

    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }

    .btn:disabled { opacity: 0.5; cursor: not-allowed; pointer-events: none; }

    .status-bar {
      padding: 6px 14px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      align-items: center;
      gap: 6px;
      background: var(--vscode-editor-background);
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .codicon-sync.loading { animation: spin 1s linear infinite; color: var(--vscode-textLink-foreground); }
    @keyframes spin { 100% { transform: rotate(360deg); } }
    .status-success { color: var(--vscode-testing-iconPassed); }
    .status-error { color: var(--vscode-testing-iconFailed); }

    .diff-container {
      flex: 1;
      overflow-y: auto;
      overflow-x: auto;
      background: var(--vscode-editor-background);
      position: relative;
    }

    .diff-output {
      font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      line-height: 1.4;
      min-width: max-content;
      padding-bottom: 20px;
    }

    .line {
      display: flex;
      width: 100%;
    }

    .line-gutter {
      width: 32px;
      min-width: 32px;
      padding-right: 8px;
      text-align: right;
      color: var(--vscode-lineNumbers-foreground, #858585);
      user-select: none;
      display: flex;
      justify-content: flex-end;
      align-items: center;
    }

    .line-content {
      padding-left: 12px;
      padding-right: 14px;
      white-space: pre;
      flex: 1;
    }

    .line-add {
      background-color: var(--vscode-diffEditor-insertedTextBackground, rgba(46, 160, 67, 0.15));
    }

    .line-add .line-content {
      color: var(--vscode-editor-foreground);
    }

    .line-remove {
      background-color: var(--vscode-diffEditor-removedTextBackground, rgba(248, 81, 73, 0.15));
    }

    .line-remove .line-content {
      color: var(--vscode-editor-foreground);
    }

    .line-hunk {
      background-color: var(--vscode-diffEditor-diagonalFill, rgba(0, 122, 204, 0.2));
      color: var(--vscode-textLink-foreground);
      margin-top: 10px;
      padding-top: 4px;
      padding-bottom: 4px;
    }

    .line-file-header {
      font-weight: bold;
      color: var(--vscode-textPreformat-foreground);
      background: var(--vscode-editorGroupHeader-tabsBackground);
      margin-top: 16px;
      padding: 6px 0;
      border-top: 1px solid var(--vscode-panel-border);
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .line-normal { color: var(--vscode-editor-foreground); }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      padding: 30px 20px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }

    .empty-icon { font-size: 48px !important; margin-bottom: 16px; opacity: 0.6; }
    .empty-state p { font-size: 13px; line-height: 1.5; margin: 0; }
    .empty-state code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 4px;
      border-radius: 3px;
    }

    .stats-row {
      display: flex;
      gap: 16px;
      padding: 8px 14px;
      background: var(--vscode-sideBar-background);
      border-top: 1px solid var(--vscode-panel-border);
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      flex-shrink: 0;
    }

    .stat { display: flex; align-items: center; gap: 4px; }
    .stat i { font-size: 12px; }
    .stat-add { color: var(--vscode-gitDecoration-addedResourceForeground); }
    .stat-del { color: var(--vscode-gitDecoration-deletedResourceForeground); }
    .stat-file { color: var(--vscode-gitDecoration-modifiedResourceForeground); }

    ::-webkit-scrollbar { width: 10px; height: 10px; }
    ::-webkit-scrollbar-corner { background: transparent; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); }
    ::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
    ::-webkit-scrollbar-thumb:active { background: var(--vscode-scrollbarSlider-activeBackground); }
  </style>
</head>
<body>

  <div class="header-container">
    <div class="header">
      <h2><i class="codicon codicon-git-compare"></i> Workspace Diff</h2>
      <div class="toolbar">
        <select class="mode-select" id="modeSelect" aria-label="Diff mode">
          <option value="all">All changes</option>
          <option value="staged">Staged only</option>
          <option value="unstaged">Unstaged only</option>
        </select>
        <div class="btn-row">
          <button class="btn btn-primary" id="btnReload">
            <i class="codicon codicon-refresh"></i> Reload
          </button>
          <button class="btn btn-secondary" id="btnCopy" disabled>
            <i class="codicon codicon-copy"></i> Copy
          </button>
        </div>
      </div>
    </div>
    <div class="status-bar" id="statusBar">
      <i class="codicon codicon-info" id="statusIcon"></i>
      <span id="statusText">Ready to load all changes.</span>
    </div>
  </div>

  <div class="diff-container" id="diffContainer">
    <div class="empty-state" id="emptyState">
      <i class="codicon codicon-file-code empty-icon"></i>
      <p id="emptyStatePrimary">No diff loaded.</p>
      <p id="emptyStateSecondary" style="margin-top: 4px; opacity: 0.8;">Choose mode, then reload to inspect Git changes.</p>
    </div>
    <div class="diff-output" id="diffOutput" style="display:none;"></div>
  </div>

  <div class="stats-row" id="statsRow" style="display:none;">
    <div class="stat stat-file">
      <i class="codicon codicon-files"></i> <span id="statFiles">0</span>
    </div>
    <div class="stat stat-add">
      <i class="codicon codicon-add"></i> <span id="statAdd">0</span>
    </div>
    <div class="stat stat-del">
      <i class="codicon codicon-remove"></i> <span id="statDel">0</span>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const MODE_LABELS = {
      all: 'all changes',
      staged: 'staged changes',
      unstaged: 'unstaged changes'
    };
    const EMPTY_MESSAGES = {
      all: 'No changes found.',
      staged: 'No staged changes found.',
      unstaged: 'No unstaged changes found.'
    };

    const btnReload = document.getElementById('btnReload');
    const btnCopy = document.getElementById('btnCopy');
    const modeSelect = document.getElementById('modeSelect');
    const diffOutput = document.getElementById('diffOutput');
    const emptyState = document.getElementById('emptyState');
    const emptyStatePrimary = document.getElementById('emptyStatePrimary');
    const emptyStateSecondary = document.getElementById('emptyStateSecondary');
    const statusIcon = document.getElementById('statusIcon');
    const statusText = document.getElementById('statusText');
    const statsRow = document.getElementById('statsRow');
    const statFiles = document.getElementById('statFiles');
    const statAdd = document.getElementById('statAdd');
    const statDel = document.getElementById('statDel');

    let rawDiff = '';
    let currentMode = 'all';

    function getModeLabel(mode) {
      return MODE_LABELS[mode] || MODE_LABELS.all;
    }

    function setStatus(iconClass, text, colorClass = '') {
      statusIcon.className = \`codicon \${iconClass} \${colorClass}\`;
      statusText.textContent = text;
    }

    function beginLoad(mode = currentMode) {
      currentMode = mode;
      modeSelect.value = mode;
      rawDiff = '';
      btnCopy.disabled = true;
      diffOutput.style.display = 'none';
      emptyState.style.display = 'none';
      statsRow.style.display = 'none';
      setStatus('codicon-sync loading', \`Loading \${getModeLabel(mode)}...\`);
    }

    function showEmptyState(primaryText, secondaryText = '') {
      emptyState.querySelector('.empty-icon').className = 'codicon codicon-pass-filled empty-icon status-success';
      emptyStatePrimary.textContent = primaryText;
      emptyStateSecondary.textContent = secondaryText;
      emptyStateSecondary.style.display = secondaryText ? 'block' : 'none';
      emptyState.style.display = 'flex';
      diffOutput.style.display = 'none';
      statsRow.style.display = 'none';
    }

    btnReload.addEventListener('click', () => {
      beginLoad(currentMode);
      vscode.postMessage({ command: 'loadDiff', mode: currentMode });
    });

    modeSelect.addEventListener('change', () => {
      currentMode = modeSelect.value;
      beginLoad(currentMode);
      vscode.postMessage({ command: 'loadDiff', mode: currentMode });
    });

    btnCopy.addEventListener('click', () => {
      if (!rawDiff) return;
      vscode.postMessage({ command: 'copyDiff' });

      const prevHtml = btnCopy.innerHTML;
      btnCopy.innerHTML = '<i class="codicon codicon-check"></i> Copied';
      btnCopy.disabled = true;
      setTimeout(() => {
        btnCopy.innerHTML = prevHtml;
        btnCopy.disabled = rawDiff.length === 0;
      }, 1500);
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.command === 'loadingDiff') {
        beginLoad(msg.mode || currentMode);
      } else if (msg.command === 'diffResult') {
        currentMode = msg.mode || currentMode;
        modeSelect.value = currentMode;

        if (msg.success) {
          rawDiff = msg.data;
          renderDiff(rawDiff, currentMode);
          btnCopy.disabled = rawDiff.length === 0;
        } else {
          rawDiff = '';
          btnCopy.disabled = true;
          setStatus('codicon-error', 'Error loading diff', 'status-error');
          emptyState.querySelector('.empty-icon').className = 'codicon codicon-warning empty-icon';
          emptyStatePrimary.textContent = msg.data;
          emptyStateSecondary.textContent = '';
          emptyStateSecondary.style.display = 'none';
          emptyState.style.display = 'flex';
          diffOutput.style.display = 'none';
          statsRow.style.display = 'none';
        }
      }
    });

    vscode.postMessage({ command: 'ready', mode: currentMode });

    function createLine(gutterText, contentText, typeClass) {
      const el = document.createElement('div');
      el.className = \`line \${typeClass}\`;

      const gutter = document.createElement('div');
      gutter.className = 'line-gutter';
      gutter.textContent = gutterText;

      const content = document.createElement('div');
      content.className = 'line-content';
      content.textContent = contentText;

      el.appendChild(gutter);
      el.appendChild(content);
      return el;
    }

    function renderDiff(text, mode) {
      currentMode = mode;
      emptyState.style.display = 'none';
      diffOutput.style.display = 'block';
      diffOutput.innerHTML = '';

      if (!text.trim()) {
        showEmptyState(EMPTY_MESSAGES[mode] || EMPTY_MESSAGES.all);
        setStatus('codicon-check', EMPTY_MESSAGES[mode] || EMPTY_MESSAGES.all, 'status-success');
        return;
      }

      let additions = 0;
      let deletions = 0;
      const filesSet = new Set();
      const lines = text.split(/\\r?\\n/);

      lines.forEach((line) => {
        if (line === undefined || line === '') return;

        if (line.startsWith('+++ ') || line.startsWith('--- ')) {
          const match = line.match(/^(?:\\+\\+\\+|---) (?:[ab]\\/)?(.*)/);
          if (match && match[1] !== '/dev/null' && match[1] !== 'dev/null') {
            filesSet.add(match[1]);
          }
        }

        if (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('diff ') || line.startsWith('index ')) {
          diffOutput.appendChild(createLine(' ', line, 'line-file-header'));
        }
        else if (line.startsWith('@@')) {
          diffOutput.appendChild(createLine(' ', line, 'line-hunk'));
        }
        else if (line.startsWith('+')) {
          additions++;
          diffOutput.appendChild(createLine('+', line.substring(1), 'line-add'));
        }
        else if (line.startsWith('-')) {
          deletions++;
          diffOutput.appendChild(createLine('-', line.substring(1), 'line-remove'));
        }
        else if (line.startsWith(' ')) {
          diffOutput.appendChild(createLine(' ', line.substring(1), 'line-normal'));
        }
        else {
          diffOutput.appendChild(createLine(' ', line, 'line-normal'));
        }
      });

      statFiles.textContent = filesSet.size;
      statAdd.textContent = additions;
      statDel.textContent = deletions;
      statsRow.style.display = 'flex';
      setStatus('codicon-check', \`Loaded \${getModeLabel(mode)}.\`, 'status-success');
    }
  </script>
</body>
</html>`;
    }
}
