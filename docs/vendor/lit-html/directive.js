

export const PartType = {
    ATTRIBUTE: 1,
    CHILD: 2,
    PROPERTY: 3,
    BOOLEAN_ATTRIBUTE: 4,
    EVENT: 5,
    ELEMENT: 6
};
export const directive = (c)=>(...values)=>({
            ['_$litDirective$']: c,
            values
        });
export class Directive {
    __part;
    __attributeIndex;
    __directive;
    _$parent;
    _$disconnectableChildren;
    constructor(_partInfo){}
    get _$isConnected() {
        return this._$parent._$isConnected;
    }
    _$initialize(part, parent, attributeIndex) {
        this.__part = part;
        this._$parent = parent;
        this.__attributeIndex = attributeIndex;
    }
    _$resolve(part, props) {
        return this.update(part, props);
    }
    update(_part, props) {
        return this.render(...props);
    }
}
