import {noChange} from '../lit-html.js';
import {directive, Directive, PartType} from '../directive.js';
class ClassMapDirective extends Directive {
    _previousClasses;
    _staticClasses;
    constructor(partInfo){
        super(partInfo);
        if (partInfo.type !== PartType.ATTRIBUTE || partInfo.name !== 'class' || partInfo.strings?.length > 2) {
            throw new Error('`classMap()` can only be used in the `class` attribute ' + 'and must be the only part in the attribute.');
        }
    }
    render(classInfo) {
        return ' ' + Object.keys(classInfo).filter((key)=>classInfo[key]).join(' ') + ' ';
    }
    update(part, [classInfo]) {
        if (this._previousClasses === undefined) {
            this._previousClasses = new Set();
            if (part.strings !== undefined) {
                this._staticClasses = new Set(part.strings.join(' ').split(/\s/).filter((s)=>s !== ''));
            }
            for(const name in classInfo){
                if (classInfo[name] && !this._staticClasses?.has(name)) {
                    this._previousClasses.add(name);
                }
            }
            return this.render(classInfo);
        }
        const classList = part.element.classList;
        for (const name of this._previousClasses){
            if (!(name in classInfo)) {
                classList.remove(name);
                this._previousClasses.delete(name);
            }
        }
        for(const name in classInfo){
            const value = !!classInfo[name];
            if (value !== this._previousClasses.has(name) && !this._staticClasses?.has(name)) {
                if (value) {
                    classList.add(name);
                    this._previousClasses.add(name);
                } else {
                    classList.remove(name);
                    this._previousClasses.delete(name);
                }
            }
        }
        return noChange;
    }
}
export const classMap = directive(ClassMapDirective);
