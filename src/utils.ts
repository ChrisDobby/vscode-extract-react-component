import * as ts from "typescript";

export function getSourceFile(text: string) {
    return ts.createSourceFile("temp-source.ts", text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
}

export function toCamelCase(str: string) {
    return str.replace(str[0], str[0].toLowerCase()).replace(/\//g, "").replace(/\s/g, "");
}

export function toPascalCase(str: string) {
    return str.replace(str[0], str[0].toUpperCase()).replace(/\//g, "").replace(/\s/g, "");
}
