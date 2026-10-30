import {nothing, noChange} from '../lit-html.js';
import {directive, Directive, PartType} from '../directive.js';
const HTML_RESULT = 1;
export class UnsafeHTMLDirective extends Directive {
    static directiveName = 'unsafeHTML';
    static resultType = HTML_RESULT;
    _value = nothing;
    _templateResult;
    constructor(partInfo){
        super(partInfo);
        if (partInfo.type !== PartType.CHILD) {
            throw new Error(`${this.constructor.directiveName}() can only be used in child bindings`);
        }
    }
    render(value) {
        if (value === nothing || value == null) {
            this._templateResult = undefined;
            return this._value = value;
        }
        if (value === noChange) {
            return value;
        }
        if (typeof value != 'string') {
            throw new Error(`${this.constructor.directiveName}() called with a non-string value`);
        }
        if (value === this._value) {
            return this._templateResult;
        }
        this._value = value;
        const strings = [
            value
        ];
        strings.raw = strings;
        return this._templateResult = {
            ['_$litType$']: this.constructor.resultType,
            strings,
            values: []
        };
    }
}
export const unsafeHTML = directive(UnsafeHTMLDirective);
