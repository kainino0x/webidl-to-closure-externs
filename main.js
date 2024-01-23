const process = require('node:process');
const fs = require('node:fs');
const webidl2 = require('webidl2');

if (process.argv.length !== 3) {
    console.error('Usage: node main.js INPUT.idl');
    console.error('  Writes out to INPUT.idl.js');
    process.exit(1);
}

const filename = process.argv[2];
const data = fs.readFileSync(filename, 'utf8');

const parsed = webidl2.parse(data);
webidl2.validate(parsed);

function assert(condition, msg) {
    if (!condition) throw new Error('assert failed: ' + msg);
}

const allByName = {};
const itemsByType = {};
const externalIncludes = {
    Navigator: [],
    WorkerNavigator: [],
};

// Loop over non-partial items
for (const item of parsed) {
    if (item.partial || item.type === 'includes') continue;

    let itemsOfType = itemsByType[item.type];
    if (!itemsOfType) {
        itemsOfType = itemsByType[item.type] = {};
    }

    assert('name' in item, 'expected name for item of type: ' + item.type);
    assert(!(item.name in itemsOfType), 'duplicate name: ' + item.name);
    itemsOfType[item.name] = item;
    allByName[item.name] = item;

    switch (item.type) {
        case 'interface':
            item.mixins = [];
            break;
        case 'dictionary':
        case 'namespace':
        case 'interface mixin':
        case 'enum':
        case 'typedef':
            break;
        default:
            assert(false, 'unimplemented top-level item type: ' + item.type);
            break;
    }
}

// Loop over includes and record them on the includer
for (const include of parsed) {
    if (include.type !== 'includes') continue;

    const included = itemsByType['interface mixin'][include.includes];
    assert(included, 'unknown include mixin');

    switch (include.target) {
        case 'Navigator':
        case 'WorkerNavigator':
            externalIncludes[include.target].push(included);
            break;
        default:
            let item = itemsByType['interface'][include.target];
            item.mixins.push(included);
            break;
    }
}

// Loop over partial items and patch them in
for (const partial of parsed) {
    if (!partial.partial) continue;

    let item = itemsByType[partial.type][partial.name];
    item.extAttrs.push(...partial.extAttrs);
    switch (partial.type) {
        case 'interface':
        case 'interface mixin':
            item.members.push(...partial.members);
            break;
        default:
            assert(false, 'unimplemented partial type: ' + partial.type);
            break;
    }
}

// Print everything out formatted as Closure externs

let result = '';
function write(line) {
    result += line + '\n';
}

function builtinToClosure(typeName, outerNullable) {
    assert(!outerNullable, 'unimplemented');
    switch (typeName) {
        // Primitives
        case 'undefined':
            return 'undefined';
        case 'boolean':
            return 'boolean';
        case 'unsigned long':
        case 'unsigned long long':
            return 'number';
        case 'DOMString':
        case 'USVString':
            return 'string';
        // Definitions from other specs
        case 'HTMLCanvasElement':
        case 'OffscreenCanvas':
        case 'ArrayBuffer':
            return '!' + typeName;
        case 'EventHandler':
            return '!Function';
        default:
            assert(false, 'unknown builtin name: ' + typeName);
    }
}

function typeToClosure(type, outerNullable) {
    // If the type is a string, we need to look it up
    if (typeof type === 'string') {
        let typeItem = allByName[type];
        if (typeItem === undefined) {
            return builtinToClosure(type, outerNullable);
        }
        return typeToClosure(typeItem, outerNullable);
    }

    if (type.type === 'typedef') {
        assert(!outerNullable, 'unimplemented');
        return typeToClosure(type.idlType);
    }

    if (type.union) {
        assert(!outerNullable, 'unimplemented');
        return type.idlType.map(t => typeToClosure(t, outerNullable)).join('|');
    }
    if (type.idlType instanceof Array) {
        assert(type.idlType.length === 1, 'idlType should be length 1');
    }

    const nullable = type.nullable || outerNullable;
    const prefix = nullable ? '?' : '!';
    switch (type.type) {
        case null:
        case 'return-type':
        case 'typedef-type':
        case 'attribute-type':
        case 'const-type':
            {
                switch (type.generic) {
                    case '':
                        return typeToClosure(type.idlType, nullable);
                    case 'FrozenArray':
                        assert(type.idlType instanceof Array);
                        return `${prefix}Array<${typeToClosure(type.idlType[0])}>`;
                    case 'Promise':
                        assert(type.idlType instanceof Array);
                        return `${prefix}Promise<${typeToClosure(type.idlType[0])}>`;
                    default:
                        assert(false, `unimplemented typeToClosure generic: ${type.generic} ${JSON.stringify(type)}`);
                }
            }
            break;
        case 'interface':
            return prefix + type.name;
        case 'enum':
            return 'string';
        default:
            assert(false, `unimplemented typeToClosure type: ${type.type} ${JSON.stringify(type)}"`);
    }
}

write('// Generated using https://github.com/kainino0x/webidl-to-closure-externs');

for (const [parent, mixins] of Object.entries(externalIncludes)) {
    write('');
    for (const mixin of mixins) {
        for (const member of mixin.members) {
            switch (member.type) {
                case 'attribute':
                    {
                        let typeNameClosure = typeToClosure(member.idlType);
                        if (typeNameClosure !== undefined) {
                            // navigator.gpu can be missing on browsers that don't have support.
                            if (typeNameClosure === '!GPU') typeNameClosure = '?GPU';
                            write(`/** @type {${typeNameClosure}} */`);
                        }
                        write(`${parent}.prototype.${member.name};`);
                    }
                    break;
                default:
                    assert(false, 'unimplemented navigator mixin member type: ' + member.type);
                    break;
            }
        }
    }
}

for (const item of Object.values(itemsByType['namespace'])) {
    write('');
    write(`const ${item.name} = {};`);

    for (const member of item.members) {
        switch (member.type) {
            case 'const':
                {
                    const typeNameClosure = typeToClosure(member.idlType);
                    if (typeNameClosure !== undefined) {
                        write(`/** @type {${typeNameClosure}} */`);
                    }
                    write(`${item.name}.${member.name};`);
                }
                break;
            default:
                assert(false, 'unimplemented namespace member type: ' + member.type);
                break;
        }
    }
}

for (const item of Object.values(itemsByType['interface'])) {
    write('');
    // Define constructor without args for simplicity
    write(`/** @constructor */\nfunction ${item.name}() {}`);

    for (const member of [...item.mixins.map(m => m.members).flat(), ...item.members]) {
        switch (member.type) {
            case 'constructor':
                // Don't need this since we don't define constructor details
                break;
            case 'attribute':
                {
                    const typeNameClosure = typeToClosure(member.idlType);
                    if (typeNameClosure !== undefined) {
                        write(`/** @type {${typeNameClosure}} */`);
                    }
                    write(`${item.name}.prototype.${member.name};`);
                }
                break;
            case 'operation':
                {
                    const typeNameClosure = typeToClosure(member.idlType);
                    if (typeNameClosure !== undefined) {
                        write(`/** @return {${typeNameClosure}} */`);
                    }
                    // Define operation without args for simplicity
                    write(`${item.name}.prototype.${member.name} = function() {};`);
                }
                break;
            case 'setlike':
                // https://webidl.spec.whatwg.org/#js-setlike
                assert(member.idlType instanceof Array && member.idlType.length === 1);
                const iterType = typeToClosure(member.idlType[0]);
                write(`\
/** @type {number} */
${item.name}.prototype.size;
/** @return {!Iterable<${iterType}>} */
${item.name}.prototype.entries = function() {};
/** @return {!Iterable<${iterType}>} */
${item.name}.prototype.keys = function() {};
/** @return {!Iterable<${iterType}>} */
${item.name}.prototype.values = function() {};
/** @return {undefined} */
${item.name}.prototype.forEach = function() {};
/** @return {boolean} */
${item.name}.prototype.has = function() {};`);
                assert(member.readonly, 'unimplemented non-readonly setlike');
                break;
            default:
                assert(false, 'unimplemented interface member type: ' + member.type);
                break;
        }
    }
}

fs.writeFileSync(filename + '.js', result);
console.error(`${filename}.js written.`);

// Check result using Closure Compiler

console.error(`Running Closure compiler...`);
const child_process = require('node:child_process');

{
    const result = child_process.spawnSync('npx', [
        'google-closure-compiler',
        '--warning_level=VERBOSE',
        '--jscomp_error=*',
        `--js=${filename}.js`,
        '--js_output_file=/dev/null',
    ], {
        stdio: 'inherit'
    });
    assert(result.status === 0, 'Closure failed with exit code ' + result.status);
}
