import * as vscode from "vscode";
import { exec } from "child_process";

/**
 * Provides the webview content for the Git Diff Viewer sidebar.
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _latestDiff = "";
  private _isViewReady = false;

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
          this._isViewReady = true;
          if (webviewView.visible) {
            this._loadDiff();
          }
          break;
        }

        case "loadDiff": {
          this._loadDiff();
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
        this._loadDiff();
      }
    });
  }

  private _loadDiff() {
    if (!this._view) {
      return;
    }

    this._latestDiff = "";
    this._view.webview.postMessage({ command: "loadingDiff" });

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      this._view.webview.postMessage({
        command: "diffResult",
        success: false,
        data: "No workspace folder is open.",
      });
      return;
    }

    const cwd = workspaceFolders[0].uri.fsPath;
    const gitFlags = "--no-pager diff --no-ext-diff --no-color";

    // Register untracked files with "Intent to Add" (-N) so git diff detects them.
    exec(`git add -N .`, { cwd }, () => {
      exec(
        `git ${gitFlags} HEAD`,
        { cwd, maxBuffer: 1024 * 1024 * 10 },
        (error, stdout, stderr) => {
          if (error) {
            // Fall back for brand new repos with no commits yet.
            if (stderr && stderr.includes("ambiguous argument 'HEAD'")) {
              exec(
                `git ${gitFlags}`,
                { cwd, maxBuffer: 1024 * 1024 * 10 },
                (err2, stdout2, stderr2) => {
                  if (err2) {
                    this._latestDiff = "";
                    this._view?.webview.postMessage({
                      command: "diffResult",
                      success: false,
                      data: stderr2 || err2.message,
                    });
                    return;
                  }

                  const diffText = stdout2 || "(no changes)";
                  this._latestDiff = diffText;
                  this._view?.webview.postMessage({
                    command: "diffResult",
                    success: true,
                    data: diffText,
                  });
                }
              );
              return;
            }

            this._latestDiff = "";
            this._view?.webview.postMessage({
              command: "diffResult",
              success: false,
              data: stderr || error.message,
            });
            return;
          }

          const diffText = stdout || "(no changes)";
          this._latestDiff = diffText;
          this._view?.webview.postMessage({
            command: "diffResult",
            success: true,
            data: diffText,
          });
        }
      );
    });
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
    /* ── Reset & Variables ──────────────────────── */
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

    /* ── Header Area ────────────────────────────── */
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

    /* ── Buttons ────────────────────────────────── */
    .btn-row { display: flex; gap: 8px; }
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

    /* ── Status Bar ─────────────────────────────── */
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

    /* ── Diff Output Container ──────────────────── */
    .diff-container {
      flex: 1;
      overflow-y: auto;
      overflow-x: auto;
      background: var(--vscode-editor-background);
      position: relative;
    }

    /* ── Diff Editor Typography & Layout ────────── */
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

    /* ── Diff Line Colors ───────────────────────── */
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
    
    /* ── Empty State ────────────────────────────── */
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

    /* ── Stats Row ──────────────────────────────── */
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

    /* ── Scrollbars ─────────────────────────────── */
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
      <div class="btn-row">
        <button class="btn btn-primary" id="btnReload">
          <i class="codicon codicon-refresh"></i> Reload
        </button>
        <button class="btn btn-secondary" id="btnCopy" disabled>
          <i class="codicon codicon-copy"></i> Copy
        </button>
      </div>
    </div>
    <div class="status-bar" id="statusBar">
      <i class="codicon codicon-info" id="statusIcon"></i>
      <span id="statusText">Ready to load diff</span>
    </div>
  </div>

  <div class="diff-container" id="diffContainer">
    <div class="empty-state" id="emptyState">
      <i class="codicon codicon-file-code empty-icon"></i>
      <p>No diff loaded.</p>
      <p style="margin-top: 4px; opacity: 0.8;">Opening this view automatically reloads <code>git diff HEAD</code></p>
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

    const btnReload  = document.getElementById('btnReload');
    const btnCopy    = document.getElementById('btnCopy');
    const diffOutput = document.getElementById('diffOutput');
    const emptyState = document.getElementById('emptyState');
    const statusIcon = document.getElementById('statusIcon');
    const statusText = document.getElementById('statusText');
    const statsRow   = document.getElementById('statsRow');
    const statFiles  = document.getElementById('statFiles');
    const statAdd    = document.getElementById('statAdd');
    const statDel    = document.getElementById('statDel');

    let rawDiff = '';

    function setStatus(iconClass, text, colorClass = '') {
      statusIcon.className = \`codicon \${iconClass} \${colorClass}\`;
      statusText.textContent = text;
    }

    function beginLoad() {
      rawDiff = '';
      btnCopy.disabled = true;
      diffOutput.style.display = 'none';
      emptyState.style.display = 'none';
      statsRow.style.display   = 'none';

      setStatus('codicon-sync loading', 'Analyzing workspace...');
    }

    btnReload.addEventListener('click', () => {
      beginLoad();
      vscode.postMessage({ command: 'loadDiff' });
    });

    btnCopy.addEventListener('click', () => {
      if (!rawDiff) return;
      vscode.postMessage({ command: 'copyDiff' });

      const prevHtml = btnCopy.innerHTML;
      btnCopy.innerHTML = '<i class="codicon codicon-check"></i> Copied';
      btnCopy.disabled = true;
      setTimeout(() => {
        btnCopy.innerHTML = prevHtml;
        btnCopy.disabled = false;
      }, 1500);
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.command === 'loadingDiff') {
        beginLoad();
      } else if (msg.command === 'diffResult') {
        if (msg.success) {
          rawDiff = msg.data;
          renderDiff(rawDiff);
          btnCopy.disabled = false;
          setStatus('codicon-check', 'Diff loaded successfully', 'status-success');
        } else {
          rawDiff = '';
          setStatus('codicon-error', 'Error loading diff', 'status-error');
          emptyState.querySelector('.empty-icon').className = 'codicon codicon-warning empty-icon';
          emptyState.querySelector('p').textContent = msg.data;
          emptyState.style.display = 'flex';
          diffOutput.style.display = 'none';
          statsRow.style.display   = 'none';
        }
      }
    });

    vscode.postMessage({ command: 'ready' });

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

    function renderDiff(text) {
      emptyState.style.display = 'none';
      diffOutput.style.display = 'block';
      diffOutput.innerHTML     = '';

      if (text.trim() === '(no changes)') {
        emptyState.querySelector('.empty-icon').className = 'codicon codicon-pass-filled empty-icon status-success';
        emptyState.querySelector('p').innerHTML = 'Working tree is clean.';
        emptyState.style.display = 'flex';
        diffOutput.style.display = 'none';
        statsRow.style.display   = 'none';
        setStatus('codicon-check', 'Clean workspace', 'status-success');
        return;
      }

      let additions = 0;
      let deletions = 0;
      const filesSet = new Set();
      const lines = text.split(/\\r?\\n/);

      lines.forEach((line) => {
        if (line === undefined || line === '') return;
        
        // Track stats
        if (line.startsWith('+++') || line.startsWith('---')) {
          const match = line.match(/^(?:\\+\\+\\+|---) (?:[ab]\\/)?(.*)/);
          if (match && match[1] !== '/dev/null' && match[1] !== 'dev/null') {
            filesSet.add(match[1]);
          }
        }

        // Render based on prefix
        if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
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
          // Context line
          diffOutput.appendChild(createLine(' ', line.substring(1), 'line-normal'));
        } 
        else {
          // Catch all for weird git output
          diffOutput.appendChild(createLine(' ', line, 'line-normal'));
        }
      });

      statFiles.textContent = filesSet.size;
      statAdd.textContent   = additions;
      statDel.textContent   = deletions;
      statsRow.style.display = 'flex';
    }
  </script>
</body>
</html>`;
  }
}
