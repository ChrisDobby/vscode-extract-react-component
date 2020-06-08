import * as vscode from "vscode";
import {
    CONFIGURATION_NAME,
    COMPONENT_NAME,
    FUNCTION_SYNTAX,
    FILENAME_CASING,
    TYPESCRIPT_PROPS_SYNTAX,
} from "./constants";
import { parseJsx, findImportsAndProps } from "./parsers";
import { createNewModule, getNewModule, updateCurrentDocument } from "./documents";

export default async () => {
    const config = vscode.workspace.getConfiguration(CONFIGURATION_NAME);
    const componentName = config.get(COMPONENT_NAME) as string;
    const functionSyntax = config.get(FUNCTION_SYNTAX) as string;
    const filenameCasing = config.get(FILENAME_CASING) as string;
    const propsSyntax = config.get(TYPESCRIPT_PROPS_SYNTAX) as string;

    const editor = vscode.window.activeTextEditor;
    const selection = editor?.selection;
    if (!editor || !selection) {
        vscode.window.showErrorMessage("No jsx is selected.");
        return;
    }

    const jsxElement = parseJsx(editor.document.getText(selection));
    if (!jsxElement) {
        vscode.window.showErrorMessage("Could not extract a component from the selection");
        return;
    }

    const { imports, props } = findImportsAndProps(editor.document.getText(), jsxElement);
    const { component, componentFilename, filename } = getNewModule(componentName, filenameCasing);
    await Promise.all([
        createNewModule({
            component,
            jsxElement,
            filename,
            functionSyntax,
            requiredImports: imports,
            props,
            propsSyntax,
        }),
        updateCurrentDocument({ selection, componentName: component, componentFilename, props }),
    ]);
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(filename));
    await vscode.commands.executeCommand("workbench.action.files.save");

    vscode.window.showInformationMessage(`Extracted ${component}`);
};
