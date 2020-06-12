import * as ts from "typescript";
import * as vscode from "vscode";
import { TextEncoder } from "util";
import * as fs from "fs";
import * as path from "path";
import { ARROW_FUNCTION_SYNTAX, PASCAL_CASE, INTERFACE, JsxProp } from "./constants";
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

function updateJsxElement(jsxElement: ValidJsx, props: JsxProp[]) {
    const convertInitialiser = (attribute: ts.JsxAttributeLike) => {
        if (attribute.kind !== ts.SyntaxKind.JsxAttribute || !attribute.initializer) {
            return undefined;
        }

        switch (attribute.initializer.kind) {
            case ts.SyntaxKind.StringLiteral:
                return attribute.initializer;
            case ts.SyntaxKind.JsxExpression:
                return { ...attribute.initializer, expression: convert(attribute.initializer.expression) };
        }
    };

    const convert = (node?: ts.Node): any => {
        if (!node) {
            return undefined;
        }

        switch (node.kind) {
            case ts.SyntaxKind.JsxSelfClosingElement: {
                const { tagName, typeArguments, attributes } = node as ts.JsxSelfClosingElement;
                return ts.createJsxSelfClosingElement(
                    tagName,
                    typeArguments,
                    ts.createJsxAttributes(
                        attributes.properties.map(prop => ({
                            ...prop,
                            initializer: convertInitialiser(prop),
                        })),
                    ),
                );
            }
            case ts.SyntaxKind.JsxElement: {
                const { openingElement, children, closingElement } = node as ts.JsxElement;
                return ts.createJsxElement(
                    ts.createJsxOpeningElement(
                        openingElement.tagName,
                        openingElement.typeArguments,
                        ts.createJsxAttributes(
                            openingElement.attributes.properties.map(prop => ({
                                ...prop,
                                initializer: convertInitialiser(prop),
                            })),
                        ),
                    ),
                    children.map(convert),
                    closingElement,
                );
            }

            case ts.SyntaxKind.TemplateExpression: {
                const { templateSpans } = node as ts.TemplateExpression;
                return { ...node, templateSpans: templateSpans.map(convert) as ts.TemplateSpan[] };
            }

            case ts.SyntaxKind.TemplateSpan: {
                const { expression } = node as ts.TemplateSpan;
                return { ...node, expression: convert(expression) };
            }

            case ts.SyntaxKind.PropertyAccessExpression: {
                const { name, expression } = node as ts.PropertyAccessExpression;
                if (
                    name.kind === ts.SyntaxKind.Identifier &&
                    expression.kind === ts.SyntaxKind.Identifier &&
                    props
                        .map(prop => prop.initialiser)
                        .includes(`${(expression as any).escapedText}.${(name as any).escapedText}`)
                ) {
                    return ts.createIdentifier(name.text);
                }

                return node;
            }

            case ts.SyntaxKind.ConditionalExpression: {
                const { condition, whenTrue, whenFalse } = node as ts.ConditionalExpression;
                return {
                    ...node,
                    condition: convert(condition),
                    whenTrue: convert(whenTrue),
                    whenFalse: convert(whenFalse),
                };
            }

            case ts.SyntaxKind.BinaryExpression: {
                const { left, right } = node as ts.BinaryExpression;
                return { ...node, left: convert(left), right: convert(right) };
            }

            case ts.SyntaxKind.ParenthesizedExpression: {
                const { expression } = node as ts.ParenthesizedExpression;
                return { ...node, expression: convert(expression) };
            }

            case ts.SyntaxKind.JsxSelfClosingElement:
            case ts.SyntaxKind.JsxElement:
                return convert(node);

            case ts.SyntaxKind.JsxExpression: {
                const { expression, dotDotDotToken } = node as ts.JsxExpression;
                return ts.createJsxExpression(dotDotDotToken, convert(expression));
            }

            default:
                return node;
        }
    };

    return convert(jsxElement);
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

function createDefinitionAndParameters(component: string, props: JsxProp[], propsSyntax: string) {
    if (props.length === 0) {
        return { propsDefinition: undefined, parameters: [] };
    }

    const name = `${component}Props`;
    const typeElements = props.map(prop =>
        ts.createPropertySignature(
            undefined,
            prop.propName,
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
    props: JsxProp[];
    propsSyntax: string;
}) {
    const { component, jsxElement, filename, functionSyntax, requiredImports, props, propsSyntax } = options;
    const { propsDefinition, parameters } = createDefinitionAndParameters(component, props, propsSyntax);
    const updatedJsx = updateJsxElement(jsxElement, props);
    const func =
        functionSyntax === ARROW_FUNCTION_SYNTAX
            ? createComponentArrowFunction(component, updatedJsx, parameters)
            : createComponentFunction(component, updatedJsx, parameters);
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
    props: JsxProp[];
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
                    ts.createIdentifier(prop.propName),
                    ts.createJsxExpression(undefined, ts.createIdentifier(prop.initialiser)),
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
