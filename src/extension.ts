import * as vscode from "vscode";
import { SidebarProvider } from "./SidebarProvider";

/**
 * Activates the extension. This is called when the extension starts.
 * Registers the SidebarProvider for the webview.
 * @param context - The extension context provided by VS Code.
 */
export function activate(context: vscode.ExtensionContext) {
    const sidebarProvider = new SidebarProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            "gitDiffViewer.sidebar",
            sidebarProvider
        )
    );
}

/**
 * Deactivates the extension. This is called when the extension shuts down.
 */
export function deactivate() { }