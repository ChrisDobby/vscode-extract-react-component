import * as ts from "typescript";
import * as vscode from "vscode";
import { TextEncoder } from "util";
import * as fs from "fs";
import * as path from "path";
import { ARROW_FUNCTION_SYNTAX, PASCAL_CASE, INTERFACE } from "./constants";
import { ValidJsx, RequiredImportDeclaration } from "./parsers";
import { getSourceFile } from "./utils";

function createParameters(typeElements: ts.TypeElement[], typeName: string) {
    if (!typeElements.length) {
        return [];
    }
    return [
        ts.createParameter(
            undefined,
            undefined,
            undefined,
            ts.createObjectBindingPattern(
                typeElements.map(typeElement =>
                    ts.createBindingElement(
                        undefined,
                        undefined,
                        typeElement.name ? (typeElement.name as any).escapedText : "",
                    ),
                ),
            ),
            undefined,
            ts.createTypeReferenceNode(typeName, undefined),
        ),
    ];
}

function createComponentFunction(componentName: string, jsxElement: ValidJsx, parameters: ts.ParameterDeclaration[]) {
    return ts.createFunctionDeclaration(
        undefined,
        undefined,
        undefined,
        componentName,
        undefined,
        parameters,
        undefined,
        ts.createBlock([ts.createReturn(jsxElement)], true),
    );
}

function createComponentArrowFunction(
    componentName: string,
    jsxElement: ValidJsx,
    parameters: ts.ParameterDeclaration[],
) {
    const arrowFunction = ts.createArrowFunction(
        undefined,
        undefined,
        parameters,
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

function createInterface(interfaceName: string, typeElements: ts.TypeElement[]) {
    return ts.createInterfaceDeclaration(undefined, undefined, interfaceName, undefined, undefined, typeElements);
}

function createType(typeName: string, typeElements: ts.TypeElement[]) {
    return ts.createTypeAliasDeclaration(
        undefined,
        undefined,
        typeName,
        undefined,
        ts.createTypeLiteralNode(typeElements),
    );
}

function createDefinitionAndParameters(component: string, props: string[], propsSyntax: string) {
    if (props.length === 0) {
        return { propsDefinition: undefined, parameters: [] };
    }

    const name = `${component}Props`;
    const typeElements = props.map(prop =>
        ts.createPropertySignature(
            undefined,
            prop,
            undefined,
            ts.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
            undefined,
        ),
    );

    const createFunc = propsSyntax === INTERFACE ? createInterface : createType;
    return { propsDefinition: createFunc(name, typeElements), parameters: createParameters(typeElements, name) };
}

export async function createNewModule(options: {
    component: string;
    jsxElement: ValidJsx;
    filename: string;
    functionSyntax: string;
    requiredImports: RequiredImportDeclaration[];
    props: string[];
    propsSyntax: string;
}) {
    const { component, jsxElement, filename, functionSyntax, requiredImports, props, propsSyntax } = options;
    const { propsDefinition, parameters } = createDefinitionAndParameters(component, props, propsSyntax);
    const func =
        functionSyntax === ARROW_FUNCTION_SYNTAX
            ? createComponentArrowFunction(component, jsxElement, parameters)
            : createComponentFunction(component, jsxElement, parameters);
    const imports = [
        ts.createImportDeclaration(
            undefined,
            undefined,
            ts.createImportClause(ts.createIdentifier("React"), undefined),
            ts.createLiteral("react"),
        ),
    ].concat(
        requiredImports.map(({ moduleSpecifier, defaultImport, namedImports }) =>
            ts.createImportDeclaration(
                undefined,
                undefined,
                ts.createImportClause(
                    defaultImport ? ts.createIdentifier(defaultImport) : undefined,
                    namedImports
                        ? ts.createNamedImports(
                              namedImports.map(namedImport =>
                                  ts.createImportSpecifier(undefined, ts.createIdentifier(namedImport)),
                              ),
                          )
                        : undefined,
                ),
                ts.createLiteral(moduleSpecifier),
            ),
        ),
    );

    const defaultExport = ts.createExportDefault(ts.createIdentifier(component));
    const newModuleSourceFile = getSourceFile("");
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    const moduleContent = [...imports, "", ...(propsDefinition ? [propsDefinition] : []), "", func, "", defaultExport]
        .map(node =>
            typeof node === "string" ? node : printer.printNode(ts.EmitHint.Unspecified, node, newModuleSourceFile),
        )
        .join("\n");
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(vscode.Uri.file(filename), encoder.encode(moduleContent));
}

function toCamelCase(str: string) {
    return str.replace(str[0], str[0].toLowerCase()).replace(/\//g, "").replace(/\s/g, "");
}

function toPascalCase(str: string) {
    return str.replace(str[0], str[0].toUpperCase()).replace(/\//g, "").replace(/\s/g, "");
}

export function getNewModule(componentName: string, filenameCasing: string) {
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

export function updateCurrentDocument(options: {
    selection: vscode.Selection;
    componentName: string;
    componentFilename: string;
    props: string[];
}) {
    const { selection, componentName, componentFilename, props } = options;
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

    const jsxElement = ts.createJsxSelfClosingElement(
        ts.createIdentifier(componentName),
        undefined,
        ts.createJsxAttributes(
            props.map(prop =>
                ts.createJsxAttribute(
                    ts.createIdentifier(prop),
                    ts.createJsxExpression(undefined, ts.createIdentifier(prop)),
                ),
            ),
        ),
    );

    const componentImport = ts.createImportDeclaration(
        undefined,
        undefined,
        ts.createImportClause(ts.createIdentifier(componentName), undefined),
        ts.createLiteral(`./${componentFilename}`),
    );

    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    const jsxText = printer.printNode(ts.EmitHint.Unspecified, jsxElement, getSourceFile(""));
    const importText = printer.printNode(ts.EmitHint.Unspecified, componentImport, getSourceFile(""));

    return new Promise(resolve =>
        editor?.edit(editBuilder => {
            editBuilder.replace(selection, jsxText);
            editBuilder.insert(new vscode.Position(lastImport, 0), importText);
            resolve();
        }),
    );
}
