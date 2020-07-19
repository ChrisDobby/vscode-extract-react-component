import * as ts from "typescript";
import * as vscode from "vscode";
import { TextEncoder } from "util";
import * as fs from "fs";
import * as path from "path";
import { ARROW_FUNCTION_SYNTAX, PASCAL_CASE, INTERFACE, JsxProp, JsxPropInitialiser } from "./constants";
import { ValidJsx, RequiredImportDeclaration } from "./parsers";
import { getSourceFile, toCamelCase, toPascalCase } from "./utils";

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

function getFunctionsToCreate(props: JsxProp[]) {
    return props.filter(({ initialiser: { expression } }) => Boolean(expression)).map(({ initialiser }) => initialiser);
}

function updateJsxElement(jsxElement: ValidJsx, props: JsxProp[]) {
    const functionsToCreate = getFunctionsToCreate(props);
    const getDerivedInitialiser = (property: ts.JsxAttributeLike) => {
        const { name } = property;
        const functionToCreate = functionsToCreate.find(
            func => name && name.kind === ts.SyntaxKind.Identifier && name.text === func.originalAttributeName,
        );

        if (!functionToCreate) {
            return undefined;
        }

        return ts.createJsxExpression(undefined, ts.createIdentifier(functionToCreate.identifier));
    };

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

    const getFullPropertyExpression = (propertyExpression: ts.PropertyAccessExpression): string => {
        const { name, expression } = propertyExpression;
        switch (expression.kind) {
            case ts.SyntaxKind.ThisKeyword:
                return `this.${name.text}`;
            case ts.SyntaxKind.Identifier:
                return `${(expression as ts.Identifier).text}.${name.text}`;
            case ts.SyntaxKind.PropertyAccessExpression:
                return `${getFullPropertyExpression(expression as ts.PropertyAccessExpression)}.${name.text}`;
            default:
                return name.text;
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
                            initializer: getDerivedInitialiser(prop) || convertInitialiser(prop),
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
                const propertyAccessExpression = node as ts.PropertyAccessExpression;
                const fullExpression = `${getFullPropertyExpression(propertyAccessExpression)}`;
                if (props.map(prop => prop.initialiser.identifier).includes(fullExpression)) {
                    return ts.createIdentifier(propertyAccessExpression.name.text);
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

            case ts.SyntaxKind.CallExpression: {
                const { expression } = node as ts.CallExpression;
                if (expression.kind !== ts.SyntaxKind.Identifier) {
                    return node;
                }
                const prop = props.find(
                    ({ initialiser: { identifier } }) => identifier === (expression as ts.Identifier).text,
                );
                if (!prop) {
                    return node;
                }

                return ts.createIdentifier(prop.propName);
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
        ts.createPropertySignature(undefined, prop.propName, undefined, prop.type, undefined),
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

function addStatements(nodeToAddTo: ts.Node, props: JsxProp[]) {
    const toAdd = props
        .map(({ initialiser: { expression, identifier } }) => (expression ? { expression, identifier } : null))
        .filter(Boolean) as any[];
    if (!toAdd.length) {
        return nodeToAddTo;
    }

    const statementsToAdd = toAdd.map(({ identifier, expression }) =>
        ts.createVariableDeclarationList(
            [ts.createVariableDeclaration(identifier, undefined, expression)],
            ts.NodeFlags.Const,
        ),
    );
    const getUpdatedStatements = (node: ts.Node): ts.Statement[] => {
        switch (node.kind) {
            case ts.SyntaxKind.VariableDeclaration: {
                const { initializer } = node as ts.VariableDeclaration;
                return initializer ? getUpdatedStatements(initializer) : [];
            }

            case ts.SyntaxKind.ArrowFunction: {
                const { body } = node as ts.ArrowFunction;
                return getUpdatedStatements(body);
            }

            case ts.SyntaxKind.FunctionDeclaration:
            case ts.SyntaxKind.FunctionExpression:
            case ts.SyntaxKind.MethodDeclaration: {
                const { body } = node as ts.FunctionDeclaration;
                return body ? getUpdatedStatements(body) : [];
            }

            case ts.SyntaxKind.Block: {
                const { statements } = node as ts.Block;
                return [...statementsToAdd, ...statements] as ts.Statement[];
            }
            case ts.SyntaxKind.JsxExpression:
            case ts.SyntaxKind.ParenthesizedExpression: {
                const { expression } = node as ts.JsxExpression;
                const returnStatement = [ts.createReturn(expression)];
                return [...statementsToAdd, ...returnStatement] as ts.Statement[];
            }

            default:
                return [];
        }
    };

    const addStatementsToNode = (statements: ts.Statement[]) => {
        if ((nodeToAddTo as any).initializer) {
            return {
                ...nodeToAddTo,
                initializer: { ...(nodeToAddTo as any).initializer, body: ts.createBlock(statements, true) },
            };
        }

        return { ...nodeToAddTo, body: ts.createBlock(statements, true) };
    };

    const updatedStatements = getUpdatedStatements(nodeToAddTo);
    const withAddedStatements = addStatementsToNode(updatedStatements);

    return withAddedStatements;
}

export function updateCurrentDocument(options: {
    componentName: string;
    componentFilename: string;
    props: JsxProp[];
    jsxDefinedIn: ts.Node;
    program: ts.Program;
    originalElement: ts.JsxElement | ts.JsxSelfClosingElement;
}) {
    const { componentName, componentFilename, props, jsxDefinedIn, program, originalElement } = options;
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

    const createAttributeExpression = ({ identifier, args }: JsxPropInitialiser) => {
        if (!args) {
            return ts.createIdentifier(identifier);
        }

        return ts.createCall(
            ts.createIdentifier(identifier),
            undefined,
            args.map(arg => ts.createIdentifier(arg)),
        );
    };

    const jsxElement = ts.createJsxSelfClosingElement(
        ts.createIdentifier(componentName),
        undefined,
        ts.createJsxAttributes(
            props.map(({ propName, initialiser }) =>
                ts.createJsxAttribute(
                    ts.createIdentifier(propName),
                    ts.createJsxExpression(undefined, createAttributeExpression(initialiser)),
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
    (originalElement as any).parent.expression = jsxElement;
    const start = editor?.document.positionAt(jsxDefinedIn.pos);
    const end = editor?.document.positionAt(jsxDefinedIn.end);
    const definedInSelection = new vscode.Range(
        new vscode.Position(start?.line as number, start?.character as number),
        new vscode.Position(end?.line as number, end?.character as number),
    );
    const updatedDefinedIn = addStatements(jsxDefinedIn, props);

    const [sourceFile] = program.getSourceFiles();
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    const importText = printer.printNode(ts.EmitHint.Unspecified, componentImport, sourceFile);
    const updatedDefinedInText = printer.printNode(ts.EmitHint.Unspecified, updatedDefinedIn, sourceFile);
    return new Promise(resolve =>
        editor?.edit(editBuilder => {
            editBuilder.replace(definedInSelection, ` ${updatedDefinedInText}`);
            editBuilder.insert(new vscode.Position(lastImport, 0), importText);
            resolve();
        }),
    );
}
