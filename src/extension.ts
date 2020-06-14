// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import extractComponent from "./extractComponent";
import { parseJsx } from "./parsers";
import { EXTRACT_REACT_COMPONENT_COMMAND } from "./constants";

export class ExtractReactComponentActionProvider implements vscode.CodeActionProvider {
    public provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
    ): vscode.ProviderResult<vscode.Command[]> {
        if (range.isEmpty) {
            return [];
        }

        return parseJsx(document.getText(range))
            ? [{ command: EXTRACT_REACT_COMPONENT_COMMAND, title: "Extract React Component" }]
            : [];
    }
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand(EXTRACT_REACT_COMPONENT_COMMAND, extractComponent);
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider({ pattern: "**/*.*" }, new ExtractReactComponentActionProvider()),
    );

    context.subscriptions.push(disposable);
}

// this method is called when your extension is deactivated
export function deactivate() {}
