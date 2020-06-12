import * as ts from "typescript";
import * as vscode from "vscode";
import { getSourceFile } from "./utils";
import { JsxProp } from "./constants";

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

    return handleNode(getSourceFile(text).getChildAt(0));
}

function extractIdentifiers(jsxElement: ValidJsx) {
    const findIdentifiers = (node: ts.Node): JsxProp[] => {
        switch (node.kind) {
            case ts.SyntaxKind.JsxSelfClosingElement: {
                const { attributes, tagName } = node as ts.JsxSelfClosingElement;
                const { text } = tagName as any;
                return ([{ propName: text, initialiser: text }] as JsxProp[]).concat(
                    ...attributes.properties.map(findIdentifiers),
                );
            }
            case ts.SyntaxKind.JsxElement: {
                const { openingElement, children } = node as ts.JsxElement;
                const nodes = (openingElement.attributes.properties as ts.NodeArray<ts.Node>).concat(children);
                const { text } = openingElement.tagName as any;
                return ([{ propName: text, initialiser: text }] as JsxProp[]).concat(...nodes.map(findIdentifiers));
            }
            case ts.SyntaxKind.JsxAttribute: {
                const initialiser = (node as ts.JsxAttribute).initializer;
                return initialiser ? findIdentifiers(initialiser) : [];
            }
            case ts.SyntaxKind.JsxExpression:
            case ts.SyntaxKind.TemplateSpan:
            case ts.SyntaxKind.ParenthesizedExpression:
            case ts.SyntaxKind.JsxSpreadAttribute: {
                const expression = (node as ts.JsxExpression).expression;
                return expression ? findIdentifiers(expression) : [];
            }
            case ts.SyntaxKind.TemplateExpression:
                return ([] as JsxProp[]).concat(...(node as ts.TemplateExpression).templateSpans.map(findIdentifiers));
            case ts.SyntaxKind.ConditionalExpression: {
                const { condition, whenTrue, whenFalse } = node as ts.ConditionalExpression;
                return ([] as JsxProp[]).concat(...[condition, whenTrue, whenFalse].map(findIdentifiers));
            }
            case ts.SyntaxKind.BinaryExpression: {
                const { left, right } = node as ts.BinaryExpression;
                return ([] as JsxProp[]).concat(...[left, right].map(findIdentifiers));
            }
            case ts.SyntaxKind.PropertyAccessExpression: {
                const { expression, name } = node as ts.PropertyAccessExpression;
                return [
                    {
                        propName: name.text,
                        initialiser: `${findIdentifiers(expression)
                            .map(ex => ex.initialiser)
                            .join(".")}.${name.text}`,
                    },
                ];
            }
            case ts.SyntaxKind.Identifier: {
                const { text } = node as ts.Identifier;
                return [{ propName: text, initialiser: text }];
            }
            case ts.SyntaxKind.ThisKeyword: {
                return [{ propName: "this", initialiser: "this" }];
            }
            default:
                return [];
        }
    };

    return findIdentifiers(jsxElement).reduce(
        (uniqueIdentifiers, identifier) =>
            uniqueIdentifiers.find(
                ({ propName, initialiser }) =>
                    identifier.propName === propName && initialiser === identifier.initialiser,
            )
                ? uniqueIdentifiers
                : uniqueIdentifiers.concat(identifier),
        [] as JsxProp[],
    );
}

export type RequiredImportDeclaration = {
    defaultImport?: string;
    namedImports: string[];
    moduleSpecifier: string;
};

type Declarations = { imports: RequiredImportDeclaration[]; variables: string[] };
function parseOriginal(documentText: string, selection: vscode.Selection) {
    const sourceFile = getSourceFile(documentText);
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
                const { initializer } = node as ts.VariableDeclaration;
                return [node].concat(...(initializer ? flattenedStatement(initializer) : []));
            }
            case ts.SyntaxKind.ArrowFunction: {
                const {
                    body: { statements },
                } = node as any;
                return statements ? ([] as ts.Node[]).concat(...statements.map(flattenedStatement)) : [];
            }

            case ts.SyntaxKind.FunctionDeclaration: {
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

    const getVariableNames = (name: ts.BindingName): string[] => {
        if (name.kind === ts.SyntaxKind.Identifier) {
            return [name.text];
        }

        if (name.kind === ts.SyntaxKind.ObjectBindingPattern) {
            return ([] as string[]).concat(...name.elements.map(({ name }) => getVariableNames(name)));
        }

        return [];
    };

    const getParameters = (variableDeclaration: ts.VariableDeclaration): string[] => {
        const { initializer } = variableDeclaration;
        if (
            !initializer ||
            !definesTheSelection(variableDeclaration) ||
            initializer.kind !== ts.SyntaxKind.ArrowFunction
        ) {
            return [];
        }

        const arrowFunctionInitializer = initializer as ts.ArrowFunction;
        return ([] as string[]).concat(
            ...arrowFunctionInitializer.parameters.map(param => getVariableNames(param.name)),
        );
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
                const params = ([] as string[]).concat(...parameters.map(param => getVariableNames(param.name)));
                return { imports, variables: [...variables, ...params] };
            }

            case ts.SyntaxKind.PropertyDeclaration: {
                const {
                    name: { text },
                } = node as any;
                return { imports, variables: [...variables, `this.${text}`] };
            }

            case ts.SyntaxKind.MethodDeclaration: {
                const {
                    name: { text },
                } = node as any;
                const methodName = `this.${text}`;
                return { imports, variables: [...variables, methodName] };
            }

            default:
                return { imports, variables };
        }
    };

    const flattenedStatements = ([] as ts.Node[]).concat(...sourceFile.statements.map(flattenedStatement));
    return flattenedStatements.reduce(statementsReducer, { imports: [], variables: [] });
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

    const jsxIdentifiers = extractIdentifiers(jsx);
    const { imports, variables } = parseOriginal(originalDocumentText, selection);
    const { requiredImports } = ([] as string[])
        .concat(...jsxIdentifiers.map(identifier => identifier.initialiser.split(".")))
        .reduce(requiredImportsReducer, {
            requiredImports: [],
        });
    const props = jsxIdentifiers.filter(({ initialiser }) =>
        variables.find(v => initialiser === v || v === initialiser.substring(0, initialiser.lastIndexOf("."))),
    );

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
