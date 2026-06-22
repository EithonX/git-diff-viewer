import * as vscode from "vscode";
import { DiffMode, ensureGitRepository, loadDiffText, toFriendlyError } from "./gitDiff";

function isDiffMode(value: unknown): value is DiffMode {
    return value === "all" || value === "staged" || value === "unstaged";
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
            await ensureGitRepository(cwd);

            const diffText = await loadDiffText(mode, cwd);
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
                data: toFriendlyError(error),
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

    .title-row {
      margin-bottom: 12px;
    }

    .title-row h1 {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--vscode-sideBarTitle-foreground);
      margin: 0 0 4px 0;
      letter-spacing: 0.5px;
    }

    .status-container {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background-color: var(--vscode-descriptionForeground);
      display: inline-block;
      transition: background-color 0.2s;
    }

    .status-dot.loading {
      background-color: var(--vscode-textLink-foreground);
      animation: pulse 1.5s infinite ease-in-out;
    }

    .status-dot.success {
      background-color: var(--vscode-testing-iconPassed, var(--vscode-descriptionForeground));
    }

    .status-dot.error {
      background-color: var(--vscode-testing-iconFailed, var(--vscode-descriptionForeground));
    }

    @keyframes pulse {
      0% { opacity: 0.4; }
      50% { opacity: 1; }
      100% { opacity: 0.4; }
    }

    .segmented-control {
      display: flex;
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 2px;
      gap: 2px;
      margin-bottom: 12px;
    }

    .segmented-control .mode-btn {
      flex: 1;
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      padding: 6px 4px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      border-radius: 3px;
      text-align: center;
      transition: background 0.1s, color 0.1s;
      outline: none;
    }

    .segmented-control .mode-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(255, 255, 255, 0.05));
      color: var(--vscode-foreground);
    }

    .segmented-control .mode-btn[aria-pressed="true"] {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-weight: 600;
    }

    .segmented-control .mode-btn:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }

    .action-row {
      display: flex;
      gap: 8px;
    }

    .btn {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 6px 12px;
      border: 1px solid transparent;
      border-radius: 4px;
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

    .btn:disabled { opacity: 0.4; cursor: not-allowed; pointer-events: none; }

    .btn:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }

    .diff-container {
      flex: 1;
      overflow-y: auto;
      overflow-x: auto;
      background: var(--vscode-editor-background);
      position: relative;
    }

    .diff-output {
      font-family: var(--vscode-editor-font-family, Menlo, Monaco, Consolas, monospace);
      font-size: var(--vscode-editor-font-size, 12px);
      line-height: 1.5;
      min-width: max-content;
      padding-bottom: 20px;
    }

    .line {
      display: flex;
      width: 100%;
    }

    .line-gutter {
      width: 24px;
      min-width: 24px;
      padding-right: 6px;
      text-align: right;
      color: var(--vscode-editorLineNumber-foreground, var(--vscode-lineNumbers-foreground));
      font-size: 11px;
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
      background-color: var(--vscode-diffEditor-insertedTextBackground, rgba(46, 160, 67, 0.1));
    }

    .line-add .line-content {
      color: var(--vscode-editor-foreground);
    }

    .line-remove {
      background-color: var(--vscode-diffEditor-removedTextBackground, rgba(248, 81, 73, 0.1));
    }

    .line-remove .line-content {
      color: var(--vscode-editor-foreground);
    }

    .line-hunk {
      background-color: var(--vscode-diffEditor-diagonalFill, rgba(0, 122, 204, 0.05));
      color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground));
      font-size: 11px;
      border-top: 1px solid var(--vscode-panel-border);
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 2px 0;
      opacity: 0.85;
    }

    .line-file-header {
      font-weight: 600;
      color: var(--vscode-textLink-foreground);
      background: var(--vscode-editorGroupHeader-tabsBackground, rgba(0, 0, 0, 0.1));
      border-top: 1px solid var(--vscode-panel-border);
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 4px 0;
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

    .empty-state p { font-size: 12px; line-height: 1.5; margin: 0; }

    .stats-row {
      display: flex;
      gap: 8px;
      padding: 8px 14px;
      background: var(--vscode-sideBar-background);
      border-top: 1px solid var(--vscode-panel-border);
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      flex-shrink: 0;
      align-items: center;
    }

    .stats-row .stat-add {
      color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-descriptionForeground));
    }

    .stats-row .stat-del {
      color: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-descriptionForeground));
    }

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
      <div class="title-row">
        <h1>Git Diff</h1>
        <div class="status-container" aria-live="polite">
          <span class="status-dot" id="statusDot"></span>
          <span class="status-text" id="statusText">Raw workspace diff ready for copy</span>
        </div>
      </div>
      
      <div class="segmented-control" role="toolbar" aria-label="Diff mode selector">
        <button class="mode-btn" data-mode="all" aria-pressed="true">All</button>
        <button class="mode-btn" data-mode="staged" aria-pressed="false">Staged</button>
        <button class="mode-btn" data-mode="unstaged" aria-pressed="false">Unstaged</button>
      </div>

      <div class="action-row">
        <button class="btn btn-primary" id="btnCopy" disabled>Copy Diff</button>
        <button class="btn btn-secondary" id="btnReload">Refresh</button>
      </div>
    </div>
  </div>

  <div class="diff-container" id="diffContainer">
    <div class="empty-state" id="emptyState">
      <p id="emptyStatePrimary">No diff loaded.</p>
      <p id="emptyStateSecondary" style="margin-top: 4px; opacity: 0.8;">Choose mode, then refresh to inspect Git changes.</p>
    </div>
    <div class="diff-output" id="diffOutput" style="display:none;"></div>
  </div>

  <div class="stats-row" id="statsRow" style="display:none;">
    <span>Files <span id="statFiles">0</span></span>
    <span>·</span>
    <span class="stat-add">+<span id="statAdd">0</span></span>
    <span>·</span>
    <span class="stat-del">-<span id="statDel">0</span></span>
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
    const modeButtons = document.querySelectorAll('.mode-btn');
    const diffOutput = document.getElementById('diffOutput');
    const emptyState = document.getElementById('emptyState');
    const emptyStatePrimary = document.getElementById('emptyStatePrimary');
    const emptyStateSecondary = document.getElementById('emptyStateSecondary');
    const statusDot = document.getElementById('statusDot');
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

    function setStatus(text, statusType = 'info') {
      statusText.textContent = text;
      statusDot.className = 'status-dot';
      if (statusType === 'loading') {
        statusDot.classList.add('loading');
      } else if (statusType === 'success') {
        statusDot.classList.add('success');
      } else if (statusType === 'error') {
        statusDot.classList.add('error');
      }
    }

    function updateActiveModeUI(activeMode) {
      currentMode = activeMode;
      modeButtons.forEach(btn => {
        const mode = btn.getAttribute('data-mode');
        const isPressed = mode === activeMode;
        btn.setAttribute('aria-pressed', isPressed ? 'true' : 'false');
      });
    }

    function beginLoad(mode = currentMode) {
      updateActiveModeUI(mode);
      rawDiff = '';
      btnCopy.disabled = true;
      diffOutput.style.display = 'none';
      emptyState.style.display = 'none';
      statsRow.style.display = 'none';
      setStatus('Loading ' + getModeLabel(mode) + '...', 'loading');
    }

    function showEmptyState(primaryText, secondaryText = '') {
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

    modeButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-mode');
        if (mode) {
          beginLoad(mode);
          vscode.postMessage({ command: 'loadDiff', mode: mode });
        }
      });
    });

    btnCopy.addEventListener('click', () => {
      if (!rawDiff) return;
      vscode.postMessage({ command: 'copyDiff' });

      const prevText = btnCopy.textContent;
      btnCopy.textContent = 'Copied';
      btnCopy.disabled = true;
      setTimeout(() => {
        btnCopy.textContent = prevText;
        btnCopy.disabled = rawDiff.length === 0;
      }, 1500);
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.command === 'loadingDiff') {
        beginLoad(msg.mode || currentMode);
      } else if (msg.command === 'diffResult') {
        const mode = msg.mode || currentMode;
        updateActiveModeUI(mode);

        if (msg.success) {
          rawDiff = msg.data;
          renderDiff(rawDiff, mode);
          btnCopy.disabled = rawDiff.length === 0;
        } else {
          rawDiff = '';
          btnCopy.disabled = true;
          setStatus('Error loading diff', 'error');
          showEmptyState(msg.data, '');
        }
      }
    });

    vscode.postMessage({ command: 'ready', mode: currentMode });

    function createLine(gutterText, contentText, typeClass) {
      const el = document.createElement('div');
      el.className = 'line ' + typeClass;

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
        setStatus(EMPTY_MESSAGES[mode] || EMPTY_MESSAGES.all, 'success');
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
      setStatus('Loaded ' + getModeLabel(mode) + '.', 'success');
    }
  </script>
</body>
</html>`;
    }
}
