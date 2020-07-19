import * as vscode from "vscode";
import * as ts from "typescript";
import {
    CONFIGURATION_NAME,
    COMPONENT_NAME,
    FUNCTION_SYNTAX,
    FILENAME_CASING,
    TYPESCRIPT_PROPS_SYNTAX,
} from "./constants";
import { parseJsx, findImportsAndProps } from "./parsers";
import { createNewModule, getNewModule, updateCurrentDocument } from "./documents";

function createProgram(
    files: {
        fileName: string;
        content: string;
        sourceFile?: ts.SourceFile;
    }[],
    compilerOptions?: ts.CompilerOptions,
): ts.Program {
    const tsConfigJson = ts.parseConfigFileTextToJson(
        "tsconfig.json",
        compilerOptions
            ? JSON.stringify(compilerOptions)
            : `{
      "compilerOptions": {
        "target": "es6",
        "module": "commonjs",
        "lib": ["es6"],
        "rootDir": ".",
        "strict": false
      }
    `,
    );
    let { options, errors } = ts.convertCompilerOptionsFromJson(tsConfigJson.config.compilerOptions, ".");
    if (errors.length) {
        throw errors;
    }
    const compilerHost = ts.createCompilerHost(options);
    compilerHost.getSourceFile = (fileName: string) => {
        const file = files.find(f => f.fileName === fileName);
        if (!file) return undefined;
        file.sourceFile =
            file.sourceFile ||
            ts.createSourceFile(fileName, file.content, ts.ScriptTarget.ES2015, false, ts.ScriptKind.TSX);
        return file.sourceFile;
    };

    compilerHost.resolveTypeReferenceDirectives = () => [];
    return ts.createProgram(
        files.map(f => f.fileName),
        options,
        compilerHost,
    );
}

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

    const program = createProgram([{ fileName: "temp.ts", content: editor.document.getText() }]);
    const { imports, props, jsxDefinedIn, originalElement } = findImportsAndProps({
        program,
        jsx: jsxElement,
        selection,
    });

    if (originalElement === null) {
        vscode.window.showErrorMessage("Error parsing the file");
        return;
    }

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
        updateCurrentDocument({
            componentName: component,
            componentFilename,
            props,
            jsxDefinedIn,
            program,
            originalElement,
        }),
    ]);
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(filename));
    await vscode.commands.executeCommand("workbench.action.files.save");

    vscode.window.showInformationMessage(`Extracted ${component}`);
};
