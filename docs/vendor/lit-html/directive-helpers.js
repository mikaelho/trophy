import {_$LH} from './lit-html.js';

const { _ChildPart: ChildPart } = _$LH;
const ENABLE_SHADYDOM_NOPATCH = true;
const wrap = ENABLE_SHADYDOM_NOPATCH && window.ShadyDOM?.inUse && window.ShadyDOM?.noPatch === true ? window.ShadyDOM.wrap : (node)=>node;
export const isPrimitive = (value)=>value === null || typeof value != 'object' && typeof value != 'function';
export const TemplateResultType = {
    HTML: 1,
    SVG: 2,
    MATHML: 3
};
export const isTemplateResult = (value, type)=>type === undefined ? value?.['_$litType$'] !== undefined : value?.['_$litType$'] === type;
export const isCompiledTemplateResult = (value)=>{
    return value?.['_$litType$']?.h != null;
};
export const isDirectiveResult = (value)=>value?.['_$litDirective$'] !== undefined;
export const getDirectiveClass = (value)=>value?.['_$litDirective$'];
export const isSingleExpression = (part)=>part.strings === undefined;
const createMarker = ()=>document.createComment('');
export const insertPart = (containerPart, refPart, part)=>{
    const container = wrap(containerPart._$startNode).parentNode;
    const refNode = refPart === undefined ? containerPart._$endNode : refPart._$startNode;
    if (part === undefined) {
        const startNode = wrap(container).insertBefore(createMarker(), refNode);
        const endNode = wrap(container).insertBefore(createMarker(), refNode);
        part = new ChildPart(startNode, endNode, containerPart, containerPart.options);
    } else {
        const endNode = wrap(part._$endNode).nextSibling;
        const oldParent = part._$parent;
        const parentChanged = oldParent !== containerPart;
        if (parentChanged) {
            part._$reparentDisconnectables?.(containerPart);
            part._$parent = containerPart;
            let newConnectionState;
            if (part._$notifyConnectionChanged !== undefined && (newConnectionState = containerPart._$isConnected) !== oldParent._$isConnected) {
                part._$notifyConnectionChanged(newConnectionState);
            }
        }
        if (endNode !== refNode || parentChanged) {
            let start = part._$startNode;
            while(start !== endNode){
                const n = wrap(start).nextSibling;
                wrap(container).insertBefore(start, refNode);
                start = n;
            }
        }
    }
    return part;
};
export const setChildPartValue = (part, value, directiveParent = part)=>{
    part._$setValue(value, directiveParent);
    return part;
};
const RESET_VALUE = {};
export const setCommittedValue = (part, value = RESET_VALUE)=>part._$committedValue = value;
export const getCommittedValue = (part)=>part._$committedValue;
export const removePart = (part)=>{
    part._$clear();
    part._$startNode.remove();
};
export const clearPart = (part)=>{
    part._$clear();
};
