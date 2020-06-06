import * as vscode from "vscode";
import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import { TextEncoder } from "util";
import {
    CONFIGURATION_NAME,
    COMPONENT_NAME,
    FUNCTION_SYNTAX,
    FILENAME_CASING,
    ARROW_FUNCTION_SYNTAX,
    PASCAL_CASE,
} from "./constants";

type ValidJsx = ts.JsxElement | ts.JsxSelfClosingElement;

function toCamelCase(str: string) {
    return str.replace(str[0], str[0].toLowerCase()).replace(/\//g, "").replace(/\s/g, "");
}

function toPascalCase(str: string) {
    return str.replace(str[0], str[0].toUpperCase()).replace(/\//g, "").replace(/\s/g, "");
}

function createComponentFunction(componentName: string, jsxElement: ValidJsx) {
    return ts.createFunctionDeclaration(
        undefined,
        undefined,
        undefined,
        componentName,
        undefined,
        [],
        undefined,
        ts.createBlock([ts.createReturn(jsxElement)], true),
    );
}

function createComponentArrowFunction(componentName: string, jsxElement: ValidJsx) {
    const arrowFunction = ts.createArrowFunction(
        undefined,
        undefined,
        [],
        undefined,
        undefined,
        ts.createBlock([ts.createReturn(jsxElement)], true),
    );

    return ts.createVariableStatement(
        undefined,
        ts.createVariableDeclarationList(
            [ts.createVariableDeclaration(componentName, undefined, arrowFunction)],
            ts.NodeFlags.Const,
        ),
    );
}

function parseJsx(text: string): ValidJsx | null {
    const handleExpressionStatement = (expressionStatement: ts.ExpressionStatement) => {
        switch (expressionStatement.expression.kind) {
            case ts.SyntaxKind.JsxSelfClosingElement:
                return expressionStatement.expression;
            case ts.SyntaxKind.JsxElement: {
                const jsxElement = expressionStatement.expression as ts.JsxElement;
                const openingTagName = (jsxElement.openingElement.tagName as ts.Identifier).text;
                const closingTagName = (jsxElement.closingElement.tagName as ts.Identifier).text;
                return openingTagName !== "" && closingTagName !== "" ? jsxElement : null;
            }
            default:
                return null;
        }
    };

    const handleSyntaxList = (syntaxList: ts.SyntaxList): any => handleNode(syntaxList.getChildAt(0));

    const handleNode = (node: ts.Node): any => {
        switch (node.kind) {
            case ts.SyntaxKind.ExpressionStatement:
                return handleExpressionStatement(node as ts.ExpressionStatement);
            case ts.SyntaxKind.SyntaxList:
                return handleSyntaxList(node as ts.SyntaxList);
            default:
                return null;
        }
    };

    const sourceFile = ts.createSourceFile("temp-source.ts", text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
    return handleNode(sourceFile.getChildAt(0));
}

function getNewModule(componentName: string, filenameCasing: string) {
    const currentFileUri = vscode.window.activeTextEditor?.document.uri;
    const fileUri = currentFileUri as vscode.Uri;
    const fsPath = path.dirname(fileUri.fsPath);
    const extension = path.extname(fileUri.fsPath);

    const filename = filenameCasing === PASCAL_CASE ? toPascalCase(componentName) : toCamelCase(componentName);
    const findModuleIndex = (index = 1): number => {
        const fileName = `${fsPath}/${filename}${index}${extension}`;
        if (fs.existsSync(fileName)) {
            return findModuleIndex(index + 1);
        }

        return index;
    };

    const filenameIndex = findModuleIndex();
    const componentFilename = `${filename}${filenameIndex}`;
    return {
        component: `${toPascalCase(componentName)}${filenameIndex}`,
        componentFilename,
        filename: `${fsPath}/${componentFilename}${extension}`,
    };
}

function updateCurrentDocument(selection: vscode.Selection, componentName: string, componentFileName: string) {
    const editor = vscode.window.activeTextEditor;
    const currentText = editor?.document.getText();
    const lines = currentText?.split("\n");
    const lastImport = Math.max(
        ...(lines
            ? lines
                  ?.map((line, index) => ({ line, index }))
                  .filter(({ line }) => line.trim().startsWith("import"))
                  .map(({ index }) => index)
            : []),
    );

    return new Promise(resolve =>
        editor?.edit(editBuilder => {
            editBuilder.replace(selection, `<${componentName} />`);
            editBuilder.insert(
                new vscode.Position(lastImport, 0),
                `import ${componentName} from './${componentFileName}'\n\n`,
            );
            resolve();
        }),
    );
}

async function createNewModule(component: string, jsxElement: ValidJsx, filename: string, functionSyntax: string) {
    const func =
        functionSyntax === ARROW_FUNCTION_SYNTAX
            ? createComponentArrowFunction(component, jsxElement)
            : createComponentFunction(component, jsxElement);
    const imports = [
        ts.createImportDeclaration(
            undefined,
            undefined,
            ts.createImportClause(ts.createIdentifier("React"), undefined),
            ts.createLiteral("react"),
        ),
    ];
    const defaultExport = ts.createExportDefault(ts.createIdentifier(component));

    const newModuleSourceFile = ts.createSourceFile("temp.ts", "", ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    const moduleContent = [...imports, func, defaultExport]
        .map(node => printer.printNode(ts.EmitHint.Unspecified, node, newModuleSourceFile))
        .join("\n\n");
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(vscode.Uri.file(filename), encoder.encode(moduleContent));
}

export default async () => {
    const config = vscode.workspace.getConfiguration(CONFIGURATION_NAME);
    const componentName = config.get(COMPONENT_NAME) as string;
    const functionSyntax = config.get(FUNCTION_SYNTAX) as string;
    const filenameCasing = config.get(FILENAME_CASING) as string;

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

    const { component, componentFilename, filename } = getNewModule(componentName, filenameCasing);
    await createNewModule(component, jsxElement, filename, functionSyntax);
    await updateCurrentDocument(selection, component, componentFilename);
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(filename));
    await vscode.commands.executeCommand("workbench.action.files.save");

    vscode.window.showInformationMessage(`Extracted ${component}`);
};
