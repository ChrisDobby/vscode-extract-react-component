import * as ts from "typescript";

function getSourceFile(text: string) {
    return ts.createSourceFile("temp-source.ts", text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
}

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
    const findIdentifiers = (node: ts.Node): ts.Identifier[] => {
        switch (node.kind) {
            case ts.SyntaxKind.JsxSelfClosingElement: {
                const { attributes, tagName } = node as ts.JsxSelfClosingElement;
                return ([tagName] as ts.Identifier[]).concat(...attributes.properties.map(findIdentifiers));
            }
            case ts.SyntaxKind.JsxElement: {
                const { openingElement, children } = node as ts.JsxElement;
                const nodes = (openingElement.attributes.properties as ts.NodeArray<ts.Node>).concat(children);
                return ([openingElement.tagName] as ts.Identifier[]).concat(...nodes.map(findIdentifiers));
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
                return ([] as ts.Identifier[]).concat(
                    ...(node as ts.TemplateExpression).templateSpans.map(findIdentifiers),
                );
            case ts.SyntaxKind.ConditionalExpression: {
                const { condition, whenTrue, whenFalse } = node as ts.ConditionalExpression;
                return ([] as ts.Identifier[]).concat(...[condition, whenTrue, whenFalse].map(findIdentifiers));
            }
            case ts.SyntaxKind.BinaryExpression: {
                const { left, right } = node as ts.BinaryExpression;
                return ([] as ts.Identifier[]).concat(...[left, right].map(findIdentifiers));
            }
            case ts.SyntaxKind.PropertyAccessExpression: {
                const { expression, name } = node as ts.PropertyAccessExpression;
                return ([] as ts.Identifier[]).concat(...[expression, name].map(findIdentifiers));
            }
            case ts.SyntaxKind.Identifier:
                return [node as ts.Identifier];
            default:
                return [];
        }
    };
    const identifiers = new Set(findIdentifiers(jsxElement).map(identifier => identifier.text));
    return Array.from(identifiers);
}

export type RequiredImportDeclaration = {
    defaultImport?: string;
    namedImports: string[];
    moduleSpecifier: string;
};
type Declarations = { imports: RequiredImportDeclaration[] };
function parseOriginal(documentText: string) {
    const getImports = ({ name, namedBindings }: ts.ImportClause) => ({
        defaultImport: name ? name.text : undefined,
        namedImports: namedBindings ? (namedBindings as any).elements.map((element: any) => element.name.text) : [],
    });
    const statementsReducer = ({ imports }: Declarations, statement: ts.Statement) => {
        switch (statement.kind) {
            case ts.SyntaxKind.ImportDeclaration: {
                const { importClause, moduleSpecifier } = statement as ts.ImportDeclaration;
                if (importClause) {
                    return {
                        imports: [
                            ...imports,
                            { moduleSpecifier: (moduleSpecifier as any).text, ...getImports(importClause) },
                        ],
                    };
                }
                return { imports };
            }
            default:
                return { imports };
        }
    };

    const sourceFile = getSourceFile(documentText);
    return sourceFile.statements.reduce(statementsReducer, { imports: [] });
}

export function findImportsAndProps(originalDocumentText: string, jsx: ValidJsx) {
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
    const { imports } = parseOriginal(originalDocumentText);

    const { requiredImports } = jsxIdentifiers.reduce(requiredImportsReducer, {
        requiredImports: [],
    });

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

    return { imports: requiredImports.slice().sort(sortImports) };
}
