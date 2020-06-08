import * as ts from "typescript";

export function getSourceFile(text: string) {
    return ts.createSourceFile("temp-source.ts", text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
}
