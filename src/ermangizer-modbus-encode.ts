import { NodeAPI, Node, NodeDef, NodeMessage } from 'node-red';

// Reuse the encoder and the protocol register table from the main (decoder) module.
// At compile time TypeScript resolves the types from src/ermangizer-modbus.ts; at
// runtime the compiled file lives next to ermangizer-modbus.js in the repo root, so
// the relative require resolves to that sibling. Requiring the module only defines
// its classes — it does NOT trigger Node-RED registration (that happens only when
// Node-RED calls the exported function).
const core = require('./ermangizer-modbus');
const ModbusEncoder = core.ModbusEncoder;
const MODBUS_REGISTERS: { [key: number]: any } = core.MODBUS_REGISTERS;

interface ErmangizerEncodeNodeDef extends NodeDef {
    name: string;
    slave: string | number;
    outputFormat: string;
}

interface ErmangizerEncodeNode extends Node {
    slave: number;
    outputFormat: string;
}

interface EncodeResult {
    frame: Buffer;
    function_code: number;
    description: string;
    start_address?: number;
}

// Semantic control commands -> register 0x1001 (status_command) values.
// These mirror the decoder's statusMap in the reverse direction.
const STATUS_COMMAND_ADDRESS = 0x1001;
const STATUS_COMMANDS: { [name: string]: number } = {
    start: 0x01,
    stop: 0x04,
    reset_error: 0x11,
    error_reset: 0x11 // alias
};

// Named read presets covering contiguous register ranges.
const READ_PRESETS: { [name: string]: { start: number; count: number } } = {
    monitoring: { start: 1, count: 7 },  // addresses 1..7 (read-only block)
    all: { start: 1, count: 22 }         // addresses 1..22 (monitoring + config)
};

// Friendly value aliases for enum-like registers, where the forward map is
// unambiguous. carrier_frequency 'L' is intentionally absent: the decoder treats
// any non-72 value as 'L', so the exact 'L' code is not defined by the protocol —
// pass a raw numeric code for it.
const WRITE_ENUMS: { [registerName: string]: { [friendly: string]: number } } = {
    carrier_frequency: { H: 72, h: 72 }
};

// Build a name -> register lookup once from the shared register table.
const REGISTER_BY_NAME: { [name: string]: any } = {};
Object.keys(MODBUS_REGISTERS).forEach((key) => {
    const reg = MODBUS_REGISTERS[Number(key)];
    REGISTER_BY_NAME[reg.name] = reg;
});

// Translates a human-friendly command object into a valid Modbus RTU frame.
// Kept free of any Node-RED dependency so it can be unit-tested directly.
class ModbusCommandEncoder {
    private encoder = new ModbusEncoder();

    public encode(payload: any, defaultSlave: number = 1): EncodeResult {
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
            throw new Error('Command payload must be an object with one of: command, write, read');
        }

        const slave = this.resolveSlave(payload.slave, defaultSlave);

        if ('command' in payload) {
            return this.encodeCommand(payload.command, payload.value, slave);
        }
        if ('write' in payload) {
            return this.encodeWrite(payload.write, payload.value, slave);
        }
        if ('read' in payload) {
            return this.encodeRead(payload.read, slave);
        }

        throw new Error('Unrecognized command object. Expected one of: command, write, read');
    }

    private resolveSlave(raw: any, fallback: number): number {
        const value = raw === undefined ? fallback : raw;
        const slave = Number(value);
        if (!Number.isInteger(slave) || slave < 0 || slave > 247) {
            throw new Error(`Invalid slave address: ${raw} (expected 0..247)`);
        }
        return slave;
    }

    private encodeCommand(command: any, value: any, slave: number): EncodeResult {
        if (typeof command !== 'string') {
            throw new Error('command must be a string');
        }

        // set_pressure is a value-carrying command; route it through the generic write path.
        if (command === 'set_pressure') {
            return this.encodeWrite('set_pressure', value, slave);
        }

        const code = STATUS_COMMANDS[command];
        if (code === undefined) {
            const valid = Object.keys(STATUS_COMMANDS).concat('set_pressure').join(', ');
            throw new Error(`Unknown command "${command}". Valid commands: ${valid}`);
        }

        const frame = this.encoder.encodeWriteRequest(slave, STATUS_COMMAND_ADDRESS, code);
        return { frame, function_code: 0x06, description: `command ${command}` };
    }

    private encodeWrite(name: any, value: any, slave: number): EncodeResult {
        if (typeof name !== 'string') {
            throw new Error('write must be a register name (string)');
        }

        const register = REGISTER_BY_NAME[name];
        if (!register) {
            throw new Error(`Unknown register "${name}"`);
        }
        if (register.readOnly) {
            throw new Error(`Register "${name}" is read-only and cannot be written`);
        }
        if (value === undefined || value === null) {
            throw new Error(`write "${name}" requires a value`);
        }

        const rawValue = this.resolveValue(register, value);
        const frame = this.encoder.encodeWriteRequest(slave, register.address, rawValue);
        return { frame, function_code: 0x06, description: `write ${name}=${value}` };
    }

    // Converts a human value into the raw 16-bit register value: resolves enum
    // aliases and applies the inverse of the register's scale.
    private resolveValue(register: any, value: any): number {
        const enumMap = WRITE_ENUMS[register.name];
        let raw: number;

        if (typeof value === 'string') {
            if (enumMap && value in enumMap) {
                raw = enumMap[value];
            } else if (!enumMap && !Number.isNaN(Number(value)) && value.trim() !== '') {
                const num = Number(value);
                raw = register.scale ? Math.round(num / register.scale) : num;
            } else {
                throw new Error(`Invalid value "${value}" for register "${register.name}"`);
            }
        } else if (typeof value === 'number') {
            raw = register.scale ? Math.round(value / register.scale) : value;
        } else {
            throw new Error(`Invalid value type for register "${register.name}"`);
        }

        if (!Number.isInteger(raw) || raw < 0 || raw > 0xFFFF) {
            throw new Error(`Value for "${register.name}" out of range (raw 0..65535): got ${raw}`);
        }
        return raw;
    }

    private encodeRead(spec: any, slave: number): EncodeResult {
        let start: number;
        let count: number;

        if (typeof spec === 'string') {
            const preset = READ_PRESETS[spec];
            if (!preset) {
                const valid = Object.keys(READ_PRESETS).join(', ');
                throw new Error(`Unknown read preset "${spec}". Valid: ${valid}, an array of register names, or {start,count}`);
            }
            start = preset.start;
            count = preset.count;
        } else if (Array.isArray(spec)) {
            ({ start, count } = this.rangeFromNames(spec));
        } else if (spec && typeof spec === 'object' && 'start' in spec && 'count' in spec) {
            start = Number(spec.start);
            count = Number(spec.count);
            if (!Number.isInteger(start) || start < 0 || start > 0xFFFF) {
                throw new Error('read.start must be an integer 0..65535');
            }
            if (!Number.isInteger(count) || count < 1 || count > 125) {
                throw new Error('read.count must be an integer 1..125');
            }
        } else {
            throw new Error('read must be a preset name, an array of register names, or {start,count}');
        }

        const frame = this.encoder.encodeReadRequest(slave, start, count);
        return { frame, function_code: 0x03, start_address: start, description: `read ${start}..${start + count - 1}` };
    }

    // Modbus 0x03 reads a contiguous block, so a list of names becomes the smallest
    // range covering them. Control registers (0x1000+) are not contiguous with the
    // 1..22 monitoring block and cannot be range-read together with it.
    private rangeFromNames(names: any[]): { start: number; count: number } {
        if (names.length === 0) {
            throw new Error('read array is empty');
        }
        const addresses = names.map((name) => {
            const register = REGISTER_BY_NAME[name];
            if (!register) {
                throw new Error(`Unknown register "${name}"`);
            }
            return register.address;
        });
        const min = Math.min(...addresses);
        const max = Math.max(...addresses);
        if (min < 1 || max > 22) {
            throw new Error('read by names only supports monitoring/config registers (addresses 1..22)');
        }
        return { start: min, count: max - min + 1 };
    }
}

const nodeRegistration = function (RED: NodeAPI) {
    function ErmangizerModbusEncodeNode(this: ErmangizerEncodeNode, config: ErmangizerEncodeNodeDef) {
        RED.nodes.createNode(this, config);

        this.name = config.name;
        const configuredSlave = parseInt(config.slave as any, 10);
        this.slave = Number.isInteger(configuredSlave) ? configuredSlave : 1;
        this.outputFormat = config.outputFormat || 'buffer';

        const commandEncoder = new ModbusCommandEncoder();

        this.on('input', (msg: NodeMessage, send: (msg: NodeMessage | NodeMessage[]) => void, done: (err?: Error) => void) => {
            const original = msg.payload;

            try {
                const result = commandEncoder.encode(original, this.slave);

                msg.payload = this.outputFormat === 'hexstring'
                    ? result.frame.toString('hex').toUpperCase()
                    : result.frame;

                // Tell a downstream decoder node where a 0x03 read starts, so it can
                // map the returned registers to the right addresses.
                if (result.start_address !== undefined) {
                    msg.modbus_start_address = result.start_address;
                }

                msg.originalPayload = original;

                send(msg);
                done();
            } catch (error: any) {
                msg.payload = {
                    error: error.message,
                    original_data: original
                };
                msg.error = error;

                send(msg);
                done(error);
            }
        });
    }

    RED.nodes.registerType('ermangizer-modbus-encode', ErmangizerModbusEncodeNode);
};

// Node-RED loads the module by calling the exported function. The command encoder
// is attached for programmatic use and unit testing.
module.exports = nodeRegistration;
module.exports.ModbusCommandEncoder = ModbusCommandEncoder;
