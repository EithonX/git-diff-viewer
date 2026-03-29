import * as vscode from "vscode";
import { exec } from "child_process";

export class SidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtml();

        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case "loadDiff": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders || workspaceFolders.length === 0) {
                        webviewView.webview.postMessage({
                            command: "diffResult",
                            success: false,
                            data: "No workspace folder is open.",
                        });
                        return;
                    }

                    const cwd = workspaceFolders[0].uri.fsPath;

                    // Added --no-ext-diff to prevent external GUI diffs from hanging the process
                    // Added --no-color to prevent ANSI escape codes from breaking the text parser
                    const gitFlags = "--no-pager diff --no-ext-diff --no-color";

                    // Try diffing against HEAD first (Captures BOTH staged and unstaged changes)
                    exec(
                        `git ${gitFlags} HEAD`,
                        { cwd, maxBuffer: 1024 * 1024 * 10 },
                        (error, stdout, stderr) => {
                            if (error) {
                                // Fallback: If 'HEAD' doesn't exist (e.g., brand new repo with no commits)
                                if (stderr && stderr.includes("ambiguous argument 'HEAD'")) {
                                    exec(
                                        `git ${gitFlags}`,
                                        { cwd, maxBuffer: 1024 * 1024 * 10 },
                                        (err2, stdout2, stderr2) => {
                                            if (err2) {
                                                webviewView.webview.postMessage({
                                                    command: "diffResult",
                                                    success: false,
                                                    data: stderr2 || err2.message,
                                                });
                                                return;
                                            }
                                            webviewView.webview.postMessage({
                                                command: "diffResult",
                                                success: true,
                                                data: stdout2 || "(no changes)",
                                            });
                                        }
                                    );
                                    return;
                                }

                                // Standard error (e.g., not a git repository)
                                webviewView.webview.postMessage({
                                    command: "diffResult",
                                    success: false,
                                    data: stderr || error.message,
                                });
                                return;
                            }

                            webviewView.webview.postMessage({
                                command: "diffResult",
                                success: true,
                                data: stdout || "(no changes)",
                            });
                        }
                    );
                    break;
                }

                case "copyDiff": {
                    if (message.data) {
                        await vscode.env.clipboard.writeText(message.data);
                        vscode.window.showInformationMessage("Diff copied to clipboard!");
                    }
                    break;
                }

                case "showError": {
                    vscode.window.showErrorMessage(message.data);
                    break;
                }
            }
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
  <style>
    /* ── Reset ───────────────────────────────────── */
    *,
    *::before,
    *::after {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ── Header ──────────────────────────────────── */
    .header {
      padding: 16px 14px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .header h2 {
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-foreground);
      margin-bottom: 14px;
      display: flex;
      align-items: center;
      gap: 7px;
    }

    .header h2 .icon {
      font-size: 16px;
      line-height: 1;
    }

    /* ── Buttons ─────────────────────────────────── */
    .btn-row {
      display: flex;
      gap: 8px;
    }

    .btn {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 8px 12px;
      border: none;
      border-radius: 4px;
      font-family: var(--vscode-font-family);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: opacity 0.15s, background 0.15s;
      outline: none;
    }

    .btn:hover {
      opacity: 0.92;
    }

    .btn:active {
      transform: scale(0.98);
    }

    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .btn-primary:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .btn-secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .btn svg {
      width: 14px;
      height: 14px;
      fill: currentColor;
    }

    /* ── Status Bar ──────────────────────────────── */
    .status-bar {
      padding: 8px 14px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 32px;
    }

    .status-bar .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--vscode-descriptionForeground);
      flex-shrink: 0;
    }

    .status-bar .dot.success {
      background: var(--vscode-testing-iconPassed, #4ec94e);
    }

    .status-bar .dot.error {
      background: var(--vscode-testing-iconFailed, #f44747);
    }

    .status-bar .dot.loading {
      background: var(--vscode-progressBar-background, #0078d4);
      animation: pulse 1s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }

    /* ── Diff Output ─────────────────────────────── */
    .diff-container {
      flex: 1;
      overflow: auto;
      padding: 0;
      position: relative;
    }

    .diff-output {
      font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      line-height: 1.55;
      white-space: pre;
      padding: 10px 14px;
      min-height: 100%;
    }

    .diff-output .line {
      padding: 0 4px;
      border-radius: 2px;
    }

    .diff-output .line-add {
      background: rgba(72, 199, 103, 0.13);
      color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b);
    }

    .diff-output .line-remove {
      background: rgba(247, 70, 70, 0.13);
      color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39);
    }

    .diff-output .line-hunk {
      color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d);
      font-weight: 600;
      margin-top: 6px;
    }

    .diff-output .line-header {
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
    }

    .diff-output .line-normal {
      color: var(--vscode-editor-foreground);
    }

    /* ── Empty State ─────────────────────────────── */
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

    .empty-state .empty-icon {
      font-size: 38px;
      margin-bottom: 14px;
      opacity: 0.5;
    }

    .empty-state p {
      font-size: 12px;
      line-height: 1.6;
      max-width: 200px;
    }

    /* ── Stats Row ───────────────────────────────── */
    .stats-row {
      display: flex;
      gap: 12px;
      padding: 8px 14px;
      border-top: 1px solid var(--vscode-panel-border);
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      flex-shrink: 0;
    }

    .stat {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .stat .count {
      font-weight: 600;
    }

    .stat.additions .count {
      color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b);
    }

    .stat.deletions .count {
      color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39);
    }

    .stat.files .count {
      color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d);
    }

    /* ── Scrollbar ───────────────────────────────── */
    .diff-container::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    .diff-container::-webkit-scrollbar-track {
      background: transparent;
    }
    .diff-container::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background);
      border-radius: 4px;
    }
    .diff-container::-webkit-scrollbar-thumb:hover {
      background: var(--vscode-scrollbarSlider-hoverBackground);
    }
  </style>
</head>
<body>

  <div class="header">
    <h2>
      <span class="icon">⎇</span> Git Diff
    </h2>
    <div class="btn-row">
      <button class="btn btn-primary" id="btnLoad">
        <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
          <path d="M13.5 2H2.5C1.67 2 1 2.67 1 3.5v9c0 .83.67 1.5 1.5 1.5h11c.83 0 1.5-.67 1.5-1.5v-9c0-.83-.67-1.5-1.5-1.5zM8 11L4 7h2.5V4h3v3H12L8 11z"/>
        </svg>
        Load Diff
      </button>
      <button class="btn btn-secondary" id="btnCopy" disabled>
        <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
          <path d="M4 4v-2.5c0-.83.67-1.5 1.5-1.5h7c.83 0 1.5.67 1.5 1.5v9c0 .83-.67 1.5-1.5 1.5H11v1.5c0 .83-.67 1.5-1.5 1.5h-7c-.83 0-1.5-.67-1.5-1.5v-9c0-.83.67-1.5 1.5-1.5H4zm1 0h5.5c.83 0 1.5.67 1.5 1.5V11h.5a.5.5 0 00.5-.5v-9a.5.5 0 00-.5-.5h-7a.5.5 0 00-.5.5V4zm-2.5 1a.5.5 0 00-.5.5v9a.5.5 0 00.5.5h7a.5.5 0 00.5-.5v-9a.5.5 0 00-.5-.5h-7z"/>
        </svg>
        Copy
      </button>
    </div>
  </div>

  <div class="status-bar" id="statusBar">
    <span class="dot"></span>
    <span id="statusText">Click <strong>Load Diff</strong> to begin</span>
  </div>

  <div class="diff-container" id="diffContainer">
    <div class="empty-state" id="emptyState">
      <div class="empty-icon">📄</div>
      <p>No diff loaded yet.<br/>Hit <strong>Load Diff</strong> to run
      <code>git diff</code> on your workspace.</p>
    </div>
    <div class="diff-output" id="diffOutput" style="display:none;"></div>
  </div>

  <div class="stats-row" id="statsRow" style="display:none;">
    <div class="stat files">
      <span class="count" id="statFiles">0</span> files
    </div>
    <div class="stat additions">
      <span>+</span><span class="count" id="statAdd">0</span>
    </div>
    <div class="stat deletions">
      <span>−</span><span class="count" id="statDel">0</span>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    const btnLoad    = document.getElementById('btnLoad');
    const btnCopy    = document.getElementById('btnCopy');
    const diffOutput = document.getElementById('diffOutput');
    const emptyState = document.getElementById('emptyState');
    const statusBar  = document.getElementById('statusBar');
    const statusText = document.getElementById('statusText');
    const statusDot  = statusBar.querySelector('.dot');
    const statsRow   = document.getElementById('statsRow');
    const statFiles  = document.getElementById('statFiles');
    const statAdd    = document.getElementById('statAdd');
    const statDel    = document.getElementById('statDel');

    let rawDiff = '';

    /* ── Button handlers ──────────────────────── */
    btnLoad.addEventListener('click', () => {
      rawDiff = '';
      btnCopy.disabled = true;
      diffOutput.style.display = 'none';
      emptyState.style.display = 'none';
      statsRow.style.display   = 'none';

      statusDot.className = 'dot loading';
      statusText.innerHTML = 'Running <code>git diff</code>…';

      vscode.postMessage({ command: 'loadDiff' });
    });

    btnCopy.addEventListener('click', () => {
      if (!rawDiff) return;
      vscode.postMessage({ command: 'copyDiff', data: rawDiff });

      // visual feedback
      const prev = btnCopy.innerHTML;
      btnCopy.innerHTML =
        '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M6.27 10.87l-2.13-2.14-.71.71L6.27 12.3l7.04-7.04-.71-.7z"/></svg> Copied!';
      btnCopy.disabled = true;
      setTimeout(() => {
        btnCopy.innerHTML = prev;
        btnCopy.disabled = false;
      }, 1500);
    });

    /* ── Receive messages ─────────────────────── */
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.command === 'diffResult') {
        if (msg.success) {
          rawDiff = msg.data;
          renderDiff(rawDiff);
          btnCopy.disabled = false;
          statusDot.className = 'dot success';
          statusText.textContent = 'Diff loaded successfully';
        } else {
          rawDiff = '';
          statusDot.className = 'dot error';
          statusText.textContent = 'Error: ' + msg.data;
          emptyState.style.display = 'flex';
          diffOutput.style.display = 'none';
          statsRow.style.display   = 'none';
        }
      }
    });

    /* ── Render diff with highlighting ────────── */
    function renderDiff(text) {
      emptyState.style.display = 'none';
      diffOutput.style.display = 'block';
      diffOutput.innerHTML     = '';

      if (text.trim() === '(no changes)') {
        emptyState.querySelector('.empty-icon').textContent = '✅';
        emptyState.querySelector('p').innerHTML =
          'Working tree is clean.<br/>No unstaged or staged changes.';
        emptyState.style.display = 'flex';
        diffOutput.style.display = 'none';
        statsRow.style.display   = 'none';
        return;
      }

      let additions = 0;
      let deletions = 0;
      const filesSet = new Set();

      // Fix: Safely split on both Windows (\\r\\n) and Unix (\\n) line endings
      const lines = text.split(/\\r?\\n/);

      lines.forEach((line) => {
        if (line === undefined) return;
        
        const el = document.createElement('div');
        el.classList.add('line');
        el.textContent = line;

        if (line.startsWith('+++') || line.startsWith('---')) {
          el.classList.add('line-header');
          // Fix: Handles standard 'a/file', no-prefix 'file' custom git configs
          const match = line.match(/^(?:\\+\\+\\+|---) (?:[ab]\\/)?(.*)/);
          if (match) {
            const fileName = match[1].trim();
            // Fix: Ignore Git's standard marker for newly created or fully deleted files
            if (fileName !== '/dev/null' && fileName !== 'dev/null') {
                filesSet.add(fileName);
            }
          }
        } else if (line.startsWith('@@')) {
          el.classList.add('line-hunk');
        } else if (line.startsWith('+')) {
          el.classList.add('line-add');
          additions++;
        } else if (line.startsWith('-')) {
          el.classList.add('line-remove');
          deletions++;
        } else if (line.startsWith('diff ')) {
          el.classList.add('line-header');
        } else {
          el.classList.add('line-normal');
        }

        diffOutput.appendChild(el);
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