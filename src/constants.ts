import * as ts from "typescript";

export const CONFIGURATION_NAME = "extractReactComponent";
export const COMPONENT_NAME = "componentName";
export const FUNCTION_SYNTAX = "functionSyntax";
export const FILENAME_CASING = "filenameCasing";
export const ARROW_FUNCTION_SYNTAX = "arrow function";
export const PASCAL_CASE = "pascal case";
export const TYPESCRIPT_PROPS_SYNTAX = "typescriptPropsSyntax";
export const INTERFACE = "interface";

export type JsxPropInitialiser = {
    identifier: string;
    originalAttributeName?: string;
    args?: string[];
    expression?: ts.Expression;
};
export type JsxProp = { propName: string; type: ts.TypeNode; initialiser: JsxPropInitialiser };

export const EXTRACT_REACT_COMPONENT_COMMAND = "extract-react-component.extractComponent";
