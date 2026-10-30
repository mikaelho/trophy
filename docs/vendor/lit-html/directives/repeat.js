import {noChange} from '../lit-html.js';
import {directive, Directive, PartType} from '../directive.js';
import {insertPart, getCommittedValue, removePart, setCommittedValue, setChildPartValue} from '../directive-helpers.js';
const generateMap = (list, start, end)=>{
    const map = new Map();
    for(let i = start; i <= end; i++){
        map.set(list[i], i);
    }
    return map;
};
class RepeatDirective extends Directive {
    _itemKeys;
    constructor(partInfo){
        super(partInfo);
        if (partInfo.type !== PartType.CHILD) {
            throw new Error('repeat() can only be used in text expressions');
        }
    }
    _getValuesAndKeys(items, keyFnOrTemplate, template) {
        let keyFn;
        if (template === undefined) {
            template = keyFnOrTemplate;
        } else if (keyFnOrTemplate !== undefined) {
            keyFn = keyFnOrTemplate;
        }
        const keys = [];
        const values = [];
        let index = 0;
        for (const item of items){
            keys[index] = keyFn ? keyFn(item, index) : index;
            values[index] = template(item, index);
            index++;
        }
        return {
            values,
            keys
        };
    }
    render(items, keyFnOrTemplate, template) {
        return this._getValuesAndKeys(items, keyFnOrTemplate, template).values;
    }
    update(containerPart, [items, keyFnOrTemplate, template]) {
        const oldParts = getCommittedValue(containerPart);
        const { values: newValues, keys: newKeys } = this._getValuesAndKeys(items, keyFnOrTemplate, template);
        if (!Array.isArray(oldParts)) {
            this._itemKeys = newKeys;
            return newValues;
        }
        const oldKeys = this._itemKeys ??= [];
        const newParts = [];
        let newKeyToIndexMap;
        let oldKeyToIndexMap;
        let oldHead = 0;
        let oldTail = oldParts.length - 1;
        let newHead = 0;
        let newTail = newValues.length - 1;
        while(oldHead <= oldTail && newHead <= newTail){
            if (oldParts[oldHead] === null) {
                oldHead++;
            } else if (oldParts[oldTail] === null) {
                oldTail--;
            } else if (oldKeys[oldHead] === newKeys[newHead]) {
                newParts[newHead] = setChildPartValue(oldParts[oldHead], newValues[newHead]);
                oldHead++;
                newHead++;
            } else if (oldKeys[oldTail] === newKeys[newTail]) {
                newParts[newTail] = setChildPartValue(oldParts[oldTail], newValues[newTail]);
                oldTail--;
                newTail--;
            } else if (oldKeys[oldHead] === newKeys[newTail]) {
                newParts[newTail] = setChildPartValue(oldParts[oldHead], newValues[newTail]);
                insertPart(containerPart, newParts[newTail + 1], oldParts[oldHead]);
                oldHead++;
                newTail--;
            } else if (oldKeys[oldTail] === newKeys[newHead]) {
                newParts[newHead] = setChildPartValue(oldParts[oldTail], newValues[newHead]);
                insertPart(containerPart, oldParts[oldHead], oldParts[oldTail]);
                oldTail--;
                newHead++;
            } else {
                if (newKeyToIndexMap === undefined) {
                    newKeyToIndexMap = generateMap(newKeys, newHead, newTail);
                    oldKeyToIndexMap = generateMap(oldKeys, oldHead, oldTail);
                }
                if (!newKeyToIndexMap.has(oldKeys[oldHead])) {
                    removePart(oldParts[oldHead]);
                    oldHead++;
                } else if (!newKeyToIndexMap.has(oldKeys[oldTail])) {
                    removePart(oldParts[oldTail]);
                    oldTail--;
                } else {
                    const oldIndex = oldKeyToIndexMap.get(newKeys[newHead]);
                    const oldPart = oldIndex !== undefined ? oldParts[oldIndex] : null;
                    if (oldPart === null) {
                        const newPart = insertPart(containerPart, oldParts[oldHead]);
                        setChildPartValue(newPart, newValues[newHead]);
                        newParts[newHead] = newPart;
                    } else {
                        newParts[newHead] = setChildPartValue(oldPart, newValues[newHead]);
                        insertPart(containerPart, oldParts[oldHead], oldPart);
                        oldParts[oldIndex] = null;
                    }
                    newHead++;
                }
            }
        }
        while(newHead <= newTail){
            const newPart = insertPart(containerPart, newParts[newTail + 1]);
            setChildPartValue(newPart, newValues[newHead]);
            newParts[newHead++] = newPart;
        }
        while(oldHead <= oldTail){
            const oldPart = oldParts[oldHead++];
            if (oldPart !== null) {
                removePart(oldPart);
            }
        }
        this._itemKeys = newKeys;
        setCommittedValue(containerPart, newParts);
        return noChange;
    }
}
export const repeat = directive(RepeatDirective);
