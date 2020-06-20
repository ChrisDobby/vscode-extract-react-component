import * as ts from "typescript";
import * as vscode from "vscode";
import { getSourceFile, toCamelCase, toPascalCase } from "./utils";
import { JsxProp, JsxPropInitialiser } from "./constants";

export type ValidJsx = ts.JsxElement | ts.JsxSelfClosingElement;

export function parseJsx(text: string): ValidJsx | null {
    const handleExpressionStatement = (expressionStatement: ts.ExpressionStatement) => {
        switch (expressionStatement.expression.kind) {
            case ts.SyntaxKind.JsxSelfClosingElement:
                return expressionStatement.expression;
            case ts.SyntaxKind.JsxElement: {
                const jsxElement = expressionStatement.expression as ts.JsxElement;
                const openingTagName = (jsxElement.openingElement.tagName as ts.Identifier).text;
                const closingTagName = (jsxElement.closingElement.tagName as ts.Identifier).text;
                return openingTagName !== "" && closingTagName !== "" && openingTagName === closingTagName
                    ? jsxElement
                    : null;
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
            case ts.SyntaxKind.SyntaxList: {
                const syntaxList = node as ts.SyntaxList;
                return syntaxList._children.length === 1 ? handleSyntaxList(node as ts.SyntaxList) : null;
            }
            default:
                return null;
        }
    };

    return handleNode(getSourceFile(text).getChildAt(0));
}

type AttributeInfo = { elementTagName?: string; attributeName?: string };
type JsxIdentifier = { propName: string; initialiser: JsxPropInitialiser };
function extractIdentifiers(jsxElement: ValidJsx) {
    const findIdentifiers = (node: ts.Node, attributeInfo: AttributeInfo): JsxIdentifier[] => {
        switch (node.kind) {
            case ts.SyntaxKind.JsxSelfClosingElement: {
                const { attributes, tagName } = node as ts.JsxSelfClosingElement;
                const { text } = tagName as any;
                return ([{ propName: text, initialiser: { identifier: text } }] as JsxIdentifier[]).concat(
                    ...attributes.properties.map(id => findIdentifiers(id, { elementTagName: text })),
                );
            }
            case ts.SyntaxKind.JsxElement: {
                const { openingElement, children } = node as ts.JsxElement;
                const nodes = (openingElement.attributes.properties as ts.NodeArray<ts.Node>).concat(children);
                const { text } = openingElement.tagName as any;
                return ([{ propName: text, initialiser: { identifier: text } }] as JsxIdentifier[]).concat(
                    ...nodes.map(childNode => findIdentifiers(childNode, { elementTagName: text })),
                );
            }
            case ts.SyntaxKind.JsxAttribute: {
                const { initializer, name } = node as ts.JsxAttribute;
                return initializer ? findIdentifiers(initializer, { ...attributeInfo, attributeName: name.text }) : [];
            }
            case ts.SyntaxKind.JsxExpression:
            case ts.SyntaxKind.TemplateSpan:
            case ts.SyntaxKind.ParenthesizedExpression:
            case ts.SyntaxKind.JsxSpreadAttribute: {
                const { expression } = node as ts.JsxExpression;
                return expression ? findIdentifiers(expression, attributeInfo) : [];
            }
            case ts.SyntaxKind.CallExpression: {
                const { expression, arguments: expressionArgs } = node as ts.CallExpression;
                if (!expression) {
                    return [];
                }
                const argumentIdentifiers = ([] as JsxIdentifier[])
                    .concat(...expressionArgs.map(arg => findIdentifiers(arg, {})))
                    .map(({ propName }) => propName);

                const callIdentifiers = findIdentifiers(expression, {}).map(({ propName, initialiser }) => ({
                    propName:
                        attributeInfo.attributeName && attributeInfo.elementTagName
                            ? `${toCamelCase(attributeInfo.elementTagName)}${toPascalCase(attributeInfo.attributeName)}`
                            : propName,
                    initialiser: { identifier: initialiser.identifier, args: argumentIdentifiers },
                }));
                return callIdentifiers;
            }
            case ts.SyntaxKind.TemplateExpression:
                return ([] as JsxIdentifier[]).concat(
                    ...(node as ts.TemplateExpression).templateSpans.map(span => findIdentifiers(span, attributeInfo)),
                );
            case ts.SyntaxKind.ConditionalExpression: {
                const { condition, whenTrue, whenFalse } = node as ts.ConditionalExpression;
                return ([] as JsxIdentifier[]).concat(
                    ...[condition, whenTrue, whenFalse].map(exp => findIdentifiers(exp, attributeInfo)),
                );
            }
            case ts.SyntaxKind.BinaryExpression: {
                const { left, right } = node as ts.BinaryExpression;
                return ([] as JsxIdentifier[]).concat(...[left, right].map(exp => findIdentifiers(exp, attributeInfo)));
            }
            case ts.SyntaxKind.PropertyAccessExpression: {
                const { expression, name } = node as ts.PropertyAccessExpression;
                return [
                    {
                        propName: name.text,
                        initialiser: {
                            identifier: `${findIdentifiers(expression, attributeInfo)
                                .map(ex => ex.initialiser.identifier)
                                .join(".")}.${name.text}`,
                        },
                    },
                ];
            }
            case ts.SyntaxKind.Identifier: {
                const { text } = node as ts.Identifier;
                return [{ propName: text, initialiser: { identifier: text } }];
            }
            case ts.SyntaxKind.ThisKeyword: {
                return [{ propName: "this", initialiser: { identifier: "this" } }];
            }
            default:
                return [];
        }
    };

    return findIdentifiers(jsxElement, {}).reduce(
        (uniqueIdentifiers, identifier) =>
            uniqueIdentifiers.find(
                ({ propName, initialiser }) =>
                    identifier.propName === propName && initialiser.identifier === identifier.initialiser.identifier,
            )
                ? uniqueIdentifiers
                : uniqueIdentifiers.concat(identifier),
        [] as JsxIdentifier[],
    );
}

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

export type RequiredImportDeclaration = {
    defaultImport?: string;
    namedImports: string[];
    moduleSpecifier: string;
};

type VariableDeclaration = { name: string; type?: ts.Type };
type Declarations = { imports: RequiredImportDeclaration[]; variables: VariableDeclaration[] };
function parseOriginal(sourceFile: ts.SourceFile, typechecker: ts.TypeChecker, selection: vscode.Selection) {
    const selectionStartPos = sourceFile.getPositionOfLineAndCharacter(selection.start.line, selection.start.character);
    const selectionEndPos = sourceFile.getPositionOfLineAndCharacter(selection.end.line, selection.end.character);

    const definesTheSelection = (node: ts.Node) => node.pos <= selectionStartPos && node.end >= selectionEndPos;

    const flattenedClassMembers = (classDeclaration: ts.ClassDeclaration) => {
        if (!definesTheSelection(classDeclaration)) {
            return [];
        }
        const { members } = classDeclaration;
        return members.reduce((flattenedMembers: any, member: ts.ClassElement) => {
            if (member.kind !== ts.SyntaxKind.MethodDeclaration || !definesTheSelection(member)) {
                return flattenedMembers.concat(member);
            }

            const { body } = member as ts.MethodDeclaration;
            if (!body || !body.statements) {
                return flattenedStatement;
            }

            return flattenedMembers.concat(...body.statements.map(flattenedStatement));
        }, [] as ts.Node[]);
    };

    const flattenedStatement = (node: ts.Node): ts.Node[] => {
        switch (node.kind) {
            case ts.SyntaxKind.ImportDeclaration:
                return [node];
            case ts.SyntaxKind.VariableStatement: {
                const { declarationList } = node as ts.VariableStatement;
                return ([] as ts.Node[]).concat(...declarationList.declarations.map(flattenedStatement));
            }
            case ts.SyntaxKind.VariableDeclaration: {
                const { initializer, type } = node as ts.VariableDeclaration;
                return [node].concat(...(initializer ? flattenedStatement(initializer) : []));
            }
            case ts.SyntaxKind.ArrowFunction: {
                const {
                    body: { statements },
                } = node as any;
                return statements ? ([] as ts.Node[]).concat(...statements.map(flattenedStatement)) : [];
            }

            case ts.SyntaxKind.FunctionDeclaration:
            case ts.SyntaxKind.FunctionExpression: {
                if (!definesTheSelection(node)) {
                    return [];
                }
                const {
                    body: { statements },
                } = node as any;
                return statements ? [node].concat(...statements.map(flattenedStatement)) : [node];
            }

            case ts.SyntaxKind.ClassDeclaration: {
                return [ts.createProperty(undefined, undefined, "props", undefined, undefined, undefined)].concat(
                    flattenedClassMembers(node as ts.ClassDeclaration),
                );
            }

            default:
                return [];
        }
    };

    const getImports = ({ name, namedBindings }: ts.ImportClause) => ({
        defaultImport: name ? name.text : undefined,
        namedImports: namedBindings ? (namedBindings as any).elements.map((element: any) => element.name.text) : [],
    });

    const getVariableNames = (name: ts.BindingName): VariableDeclaration[] => {
        if (name.kind === ts.SyntaxKind.Identifier) {
            return [{ name: name.text, type: typechecker.getTypeAtLocation(name) }];
        }

        if (name.kind === ts.SyntaxKind.ObjectBindingPattern) {
            return ([] as VariableDeclaration[]).concat(...name.elements.map(({ name }) => getVariableNames(name)));
        }

        return [];
    };

    const getParameters = (variableDeclaration: ts.VariableDeclaration): VariableDeclaration[] => {
        const functionKinds = [ts.SyntaxKind.ArrowFunction, ts.SyntaxKind.FunctionExpression];
        const { initializer } = variableDeclaration;
        if (!initializer || !definesTheSelection(variableDeclaration) || !functionKinds.includes(initializer.kind)) {
            return [];
        }

        const functionInitializer = initializer as ts.ArrowFunction | ts.FunctionExpression;
        return functionInitializer.parameters
            ? ([] as VariableDeclaration[]).concat(
                  ...functionInitializer.parameters.map(param => getVariableNames(param.name)),
              )
            : [];
    };

    const statementsReducer = ({ imports, variables }: Declarations, node: ts.Node) => {
        switch (node.kind) {
            case ts.SyntaxKind.ImportDeclaration: {
                const { importClause, moduleSpecifier } = node as ts.ImportDeclaration;
                if (importClause) {
                    return {
                        imports: [
                            ...imports,
                            { moduleSpecifier: (moduleSpecifier as any).text, ...getImports(importClause) },
                        ],
                        variables,
                    };
                }
                return { imports, variables };
            }

            case ts.SyntaxKind.VariableDeclaration: {
                const variableDeclaration = node as ts.VariableDeclaration;
                const { name } = variableDeclaration;
                return {
                    imports,
                    variables: [...variables, ...getVariableNames(name), ...getParameters(variableDeclaration)],
                };
            }

            case ts.SyntaxKind.FunctionDeclaration: {
                if (!definesTheSelection(node)) {
                    return { imports, variables };
                }
                const { parameters } = node as ts.FunctionDeclaration;
                const params = ([] as VariableDeclaration[]).concat(
                    ...parameters.map(param => getVariableNames(param.name)),
                );
                return { imports, variables: [...variables, ...params] };
            }

            case ts.SyntaxKind.PropertyDeclaration: {
                const {
                    name: { text },
                } = node as any;
                return { imports, variables: [...variables, { name: `this.${text}` }] };
            }

            case ts.SyntaxKind.MethodDeclaration: {
                const {
                    name: { text },
                } = node as any;
                const methodName = `this.${text}`;
                return { imports, variables: [...variables, { name: methodName }] };
            }

            default:
                return { imports, variables };
        }
    };

    const flattenedStatements = ([] as ts.Node[]).concat(...sourceFile.statements.map(flattenedStatement));
    return flattenedStatements.reduce(statementsReducer, { imports: [], variables: [] });
}

function createTypeNode(typechecker: ts.TypeChecker, type?: ts.Type): ts.TypeNode {
    if (!type) {
        return ts.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);
    }

    return typechecker.typeToTypeNode(type) || ts.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);
}

export function findImportsAndProps(options: {
    originalDocumentText: string;
    jsx: ValidJsx;
    selection: vscode.Selection;
}) {
    const { originalDocumentText, jsx, selection } = options;
    const requiredImportsReducer = (
        { requiredImports }: { requiredImports: RequiredImportDeclaration[] },
        identifier: string,
    ) => {
        const isDefaultImportFrom = imports
            .filter(imp => imp.defaultImport === identifier)
            .map(({ moduleSpecifier }) => moduleSpecifier);
        const isNamedImportFrom = imports
            .filter(imp => imp.namedImports.includes(identifier))
            .map(({ moduleSpecifier }) => moduleSpecifier);

        if (!isDefaultImportFrom.length && !isNamedImportFrom.length) {
            return { requiredImports };
        }

        const updatedImports = requiredImports
            .map(imp => ({
                ...imp,
                defaultImport: isDefaultImportFrom.map(moduleSpecifier => moduleSpecifier).includes(imp.moduleSpecifier)
                    ? identifier
                    : imp.defaultImport,
                namedImports: isNamedImportFrom.map(moduleSpecifier => moduleSpecifier).includes(imp.moduleSpecifier)
                    ? [...imp.namedImports, identifier]
                    : imp.namedImports,
            }))
            .concat(
                isDefaultImportFrom
                    .filter(
                        moduleSpecifier => !requiredImports.map(imp => imp.moduleSpecifier).includes(moduleSpecifier),
                    )
                    .map(moduleSpecifier => ({
                        moduleSpecifier,
                        defaultImport: identifier,
                        namedImports: [],
                    })),
            )
            .concat(
                isNamedImportFrom
                    .filter(
                        moduleSpecifier => !requiredImports.map(imp => imp.moduleSpecifier).includes(moduleSpecifier),
                    )
                    .map(moduleSpecifier => ({
                        moduleSpecifier,
                        defaultImport: undefined,
                        namedImports: [identifier],
                    })),
            );
        return { requiredImports: updatedImports };
    };

    const jsxIdentifiers = extractIdentifiers(jsx).filter(({ initialiser }) => Boolean(initialiser));
    const program = createProgram([{ fileName: "temp.ts", content: originalDocumentText }]);
    const [sourceFile] = program.getSourceFiles();
    const typechecker = program.getTypeChecker();

    const { imports, variables } = parseOriginal(sourceFile, typechecker, selection);
    const { requiredImports } = ([] as string[])
        .concat(...jsxIdentifiers.map(identifier => identifier.initialiser.identifier.split(".")))
        .reduce(requiredImportsReducer, {
            requiredImports: [],
        });
    const props = jsxIdentifiers.reduce((propsWithTypes, identifier) => {
        const identifierName = identifier.initialiser.identifier;
        const variable = variables.find(
            v => identifierName === v.name || v.name === identifierName.substring(0, identifierName.lastIndexOf(".")),
        );
        return variable
            ? [...propsWithTypes, { ...identifier, type: createTypeNode(typechecker, variable.type) }]
            : propsWithTypes;
    }, [] as JsxProp[]);

    const fileImportChars = [".", "/"];
    const sortImports = (imp1: RequiredImportDeclaration, imp2: RequiredImportDeclaration) => {
        const imp1Begin = imp1.moduleSpecifier[0];
        const imp2Begin = imp2.moduleSpecifier[0];

        if (fileImportChars.includes(imp1Begin) && !fileImportChars.includes(imp2Begin)) {
            return 1;
        }
        if (fileImportChars.includes(imp2Begin) && !fileImportChars.includes(imp1Begin)) {
            return -1;
        }
        return 0;
    };

    return { imports: requiredImports.slice().sort(sortImports), props };
}
