'use strict';

// Plain-Node test runner (no external deps). Run with: npm test
const assert = require('assert');
const mod = require('../ermangizer-modbus.js');

const { ModbusDecoder, ModbusEncoder, calculateCRC16, appendCRC } = mod;
const decoder = new ModbusDecoder();
const encoder = new ModbusEncoder();

let passed = 0;
let failed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.log(`  ✗ ${name}`);
        console.log(`      ${err.message}`);
    }
}

function hexToBuf(hex) {
    return Buffer.from(hex.replace(/\s/g, ''), 'hex');
}

// ---------------------------------------------------------------------------
// 1. CRC-16 against the official documented frames
// ---------------------------------------------------------------------------
console.log('CRC-16 (official doc frames):');
const docFrames = {
    'read request (22 regs)': '3f 03 00 01 00 16 91 1a',
    'read request (23 regs)': '3f 03 00 01 00 17 50 da',
    'error response 0x83':    '3F 83 02 A1 3D',
    'write set_pressure':     '3f 06 10 00 01 90 88 28',
    'read response (22 regs)':'3F 03 2C 01 F4 00 01 00 EA 00 20 00 00 00 00 00 01 00 00 00 00 00 01 00 1E 00 0A 00 1E 00 4C 00 14 00 0A 00 F0 00 00 00 06 00 55 00 00 00 3F 38 EE'
};
for (const [name, hex] of Object.entries(docFrames)) {
    test(`valid CRC: ${name}`, () => {
        const buf = hexToBuf(hex);
        const body = buf.slice(0, -2);
        const recv = buf.readUInt16LE(buf.length - 2);
        assert.strictEqual(calculateCRC16(body), recv);
        // appendCRC must reproduce the exact original frame
        assert.deepStrictEqual(appendCRC(body), buf);
    });
}

// ---------------------------------------------------------------------------
// 2. Decode the official read response (22 registers, decimal addresses 1..22)
// ---------------------------------------------------------------------------
console.log('\nDecode official read response:');
const readResp = decoder.decodeModbusMessage(docFrames['read response (22 regs)']);
test('slave / function', () => {
    assert.strictEqual(readResp.slave_address, 0x3F);
    assert.strictEqual(readResp.function_name, 'Read Holding Registers');
});
test('output_frequency = 50.0 Hz', () => {
    assert.strictEqual(readResp.registers.output_frequency.value, 50.0);
});
test('input_voltage = 234 V', () => {
    assert.strictEqual(readResp.registers.input_voltage.value, 234);
});
test('temperature = 32 C', () => {
    assert.strictEqual(readResp.registers.temperature.value, 32);
});
test('error_code = No error', () => {
    assert.strictEqual(readResp.registers.error_code.description, 'No error');
});
test('status_code = running, no water shortage', () => {
    assert.strictEqual(readResp.registers.status_code.running, true);
    assert.strictEqual(readResp.registers.status_code.water_shortage, false);
});
test('carrier_frequency (addr 14) = L', () => {
    // This register only decodes when addresses are treated as DECIMAL.
    assert.ok(readResp.registers.carrier_frequency, 'carrier_frequency missing');
    assert.strictEqual(readResp.registers.carrier_frequency.value, 'L');
    assert.strictEqual(readResp.registers.carrier_frequency.address, 14);
});
test('measurement_range (addr 19) = 6 bar', () => {
    assert.ok(readResp.registers.measurement_range, 'measurement_range missing');
    assert.strictEqual(readResp.registers.measurement_range.value, '6 bar');
});
test('local_address (addr 22) = 63', () => {
    assert.ok(readResp.registers.local_address, 'local_address missing');
    assert.strictEqual(readResp.registers.local_address.value, 63);
});
test('reserved addresses 8 & 9 surface as unknown', () => {
    assert.ok(readResp.registers.unknown_0x0008);
    assert.ok(readResp.registers.unknown_0x0009);
});

// ---------------------------------------------------------------------------
// 3. Decode write request and error response
// ---------------------------------------------------------------------------
console.log('\nDecode write / error frames:');
test('write set_pressure = 4.0 bar', () => {
    const d = decoder.decodeModbusMessage(docFrames['write set_pressure']);
    assert.strictEqual(d.function_name, 'Write Single Register');
    assert.strictEqual(d.registers.set_pressure.value, 4.0);
    assert.strictEqual(d.registers.set_pressure.operation, 'write');
});
test('error response = Illegal Data Address', () => {
    const d = decoder.decodeModbusMessage(docFrames['error response 0x83']);
    assert.strictEqual(d.function_name, 'Error Response');
    assert.strictEqual(d.error.code, 2);
    assert.strictEqual(d.error.modbus_error, true);
});

// ---------------------------------------------------------------------------
// 4. Round-trip: encode -> decode (both directions)
// ---------------------------------------------------------------------------
console.log('\nRound-trip encode -> decode:');
test('read response round-trip', () => {
    // values for addresses 1..22
    const values = [500, 12, 230, 40, 250, 0, 3, 0, 0, 0, 30, 15, 25, 72, 30, 5, 200, 1, 10, 80, 1, 5];
    const frame = encoder.encodeReadResponse(0x3F, values);
    const d = decoder.decodeModbusMessage(frame);
    assert.strictEqual(d.registers.output_frequency.value, 50.0);      // 500 * 0.1
    assert.strictEqual(d.registers.pressure.value, 2.5);               // 250 * 0.01
    assert.strictEqual(d.registers.status_code.water_shortage, true);  // 3 -> bit0
    assert.strictEqual(d.registers.status_code.running, true);         // 3 -> bit1
    assert.strictEqual(d.registers.carrier_frequency.value, 'H');      // 72
    assert.strictEqual(d.registers.measurement_range.value, '10 bar'); // 10
    assert.strictEqual(d.registers.local_address.value, 5);            // 5
});
test('write request round-trip', () => {
    const frame = encoder.encodeWriteRequest(0x3F, 0x1000, 350);
    const d = decoder.decodeModbusMessage(frame);
    assert.strictEqual(d.registers.set_pressure.value, 3.5); // 350 * 0.01
});
test('encoded read request matches the doc frame byte-for-byte', () => {
    const frame = encoder.encodeReadRequest(0x3F, 1, 0x16);
    assert.deepStrictEqual(frame, hexToBuf(docFrames['read request (22 regs)']));
});
test('encoded write request matches the doc frame byte-for-byte', () => {
    const frame = encoder.encodeWriteRequest(0x3F, 0x1000, 400);
    assert.deepStrictEqual(frame, hexToBuf(docFrames['write set_pressure']));
});
test('encoded error response matches the doc frame byte-for-byte', () => {
    const frame = encoder.encodeErrorResponse(0x3F, 0x03, 2);
    assert.deepStrictEqual(frame, hexToBuf(docFrames['error response 0x83']));
});

// ---------------------------------------------------------------------------
// 5. All three input formats decode identically
// ---------------------------------------------------------------------------
console.log('\nInput format equivalence:');
test('buffer / hex / spaced-hex / array all match', () => {
    const hex = '3f06100001908828';
    const fromHex = decoder.decodeModbusMessage(hex);
    const fromSpaced = decoder.decodeModbusMessage('3f 06 10 00 01 90 88 28');
    const fromBuffer = decoder.decodeModbusMessage(hexToBuf(hex));
    const fromArray = decoder.decodeModbusMessage([0x3f, 0x06, 0x10, 0x00, 0x01, 0x90, 0x88, 0x28]);
    const val = (d) => d.registers.set_pressure.value;
    assert.strictEqual(val(fromHex), 4.0);
    assert.strictEqual(val(fromSpaced), 4.0);
    assert.strictEqual(val(fromBuffer), 4.0);
    assert.strictEqual(val(fromArray), 4.0);
});

// ---------------------------------------------------------------------------
// 6. Error handling
// ---------------------------------------------------------------------------
console.log('\nError handling:');
test('corrupted CRC is rejected', () => {
    assert.throws(() => decoder.decodeModbusMessage('3f 03 00 01 00 16 00 00'), /CRC check failed/);
});
test('message too short is rejected', () => {
    assert.throws(() => decoder.decodeModbusMessage('3f03'), /too short/);
});
test('odd-length hex string is rejected', () => {
    assert.throws(() => decoder.decodeModbusMessage('3f030'), /Invalid hex string length/);
});
test('unsupported input type is rejected', () => {
    assert.throws(() => decoder.decodeModbusMessage({ foo: 'bar' }), /Unsupported input type/);
});

// ---------------------------------------------------------------------------
// 7. Node simplified output (scalar per register, via a mock Node-RED runtime)
// ---------------------------------------------------------------------------
console.log('\nNode simplified output:');
const EventEmitter = require('events');

function runNode(config, payload) {
    let Ctor;
    const RED = {
        nodes: {
            createNode(node) {
                Object.assign(node, EventEmitter.prototype);
                EventEmitter.call(node);
            },
            registerType(_name, ctor) { Ctor = ctor; }
        }
    };
    mod(RED);
    const node = Object.create(Ctor.prototype);
    Ctor.call(node, config);
    let out;
    node.emit('input', { payload }, (m) => { out = m; }, () => {});
    return out.payload;
}

test('simplified: error_code -> scalar code, status_code -> raw bitfield', () => {
    const p = runNode({ inputType: 'auto', outputFormat: 'simplified' },
        docFrames['read response (22 regs)']);
    assert.strictEqual(p.output_frequency, 50.0);
    assert.strictEqual(p.error_code, 0);        // scalar code, not an object
    assert.strictEqual(p.status_code, 1);       // raw_value bitfield
    assert.strictEqual(p.carrier_frequency, 'L'); // value wins when present
    assert.strictEqual(typeof p.error_code, 'number');
});

test('simplified: write set_pressure -> scalar 4.0', () => {
    const p = runNode({ inputType: 'auto', outputFormat: 'simplified' },
        docFrames['write set_pressure']);
    assert.strictEqual(p.set_pressure, 4.0);
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
