import { NodeAPI, Node, NodeDef, NodeMessage } from 'node-red';

interface ErmangizerModbusNodeDef extends NodeDef {
    name: string;
    inputType: string;
    outputFormat: string;
}

interface ModbusRegister {
    address: number;
    name: string;
    unit: string;
    description: string;
    readOnly: boolean;
    scale?: number;
}

interface DecodedData {
    [key: string]: any;
}

interface ErmangizerModbusNode extends Node {
    inputType: string;
    outputFormat: string;
}

// NOTE: register addresses are DECIMAL, per the ERMANGIZER protocol ("в десятичной
// системе"). Read/monitoring registers are at addresses 1-22; the two control
// registers are at decimal 4096/4097 (= hex 0x1000/0x1001, the form used on the wire).
const MODBUS_REGISTERS: { [key: number]: ModbusRegister } = {
    // Read-only registers (addresses 1-7)
    1: { address: 1, name: 'output_frequency', unit: '0.1 Hz', description: 'Current output frequency value', readOnly: true, scale: 0.1 },
    2: { address: 2, name: 'output_current', unit: '0.1 A', description: 'Current output current value', readOnly: true, scale: 0.1 },
    3: { address: 3, name: 'input_voltage', unit: 'V', description: 'Current input voltage value', readOnly: true },
    4: { address: 4, name: 'temperature', unit: '°C', description: 'Current temperature display', readOnly: true },
    5: { address: 5, name: 'pressure', unit: '0.01 bar', description: 'Actual pressure value', readOnly: true, scale: 0.01 },
    6: { address: 6, name: 'error_code', unit: '', description: 'Error code', readOnly: true },
    7: { address: 7, name: 'status_code', unit: '', description: 'Status code', readOnly: true },

    // Read-write registers (addresses 10-22)
    10: { address: 10, name: 'factory_reset', unit: '', description: 'Restore factory settings', readOnly: false },
    11: { address: 11, name: 'initial_pressure_diff', unit: '0.01 bar', description: 'Pressure difference for sleep/wake (exit) mode', readOnly: false, scale: 0.01 },
    12: { address: 12, name: 'water_shortage_pressure', unit: '0.01 bar', description: 'Dry-run pressure value', readOnly: false, scale: 0.01 },
    13: { address: 13, name: 'water_shortage_time', unit: 's', description: 'Dry-run time', readOnly: false },
    14: { address: 14, name: 'carrier_frequency', unit: '', description: 'Carrier frequency (see manual param P014)', readOnly: false },
    15: { address: 15, name: 'accel_decel_time', unit: '0.1 ms', description: 'Acceleration and deceleration time', readOnly: false, scale: 0.1 },
    16: { address: 16, name: 'pressure_tolerance', unit: '0.01 bar', description: 'Allowable pressure error', readOnly: false, scale: 0.01 },
    17: { address: 17, name: 'min_shutdown_freq', unit: '0.1 Hz', description: 'Minimum frequency', readOnly: false, scale: 0.1 },
    18: { address: 18, name: 'continuous_operation', unit: '', description: 'Disable sleep mode (continuous operation)', readOnly: false },
    19: { address: 19, name: 'measurement_range', unit: 'bar', description: 'Pressure sensor range selection', readOnly: false },
    20: { address: 20, name: 'overheat_setting', unit: '°C', description: 'Temperature alarm threshold', readOnly: false },
    21: { address: 21, name: 'direction_setting', unit: '', description: 'Rotation direction (for ER-G-380-02)', readOnly: false },
    22: { address: 22, name: 'local_address', unit: '', description: 'Local address', readOnly: false },

    // Control registers (decimal 4096/4097 = hex 0x1000/0x1001)
    0x1000: { address: 0x1000, name: 'set_pressure', unit: '0.01 BAR', description: 'Set pressure value', readOnly: false, scale: 0.01 },
    0x1001: { address: 0x1001, name: 'status_command', unit: '', description: 'Command status code', readOnly: false }
};

const ERROR_CODES: { [key: number]: string } = {
    0: 'No error',
    1: 'Equipment overcurrent, short circuit',
    2: 'Power overload',
    3: 'Pressure sensor fault or incorrect connection',
    4: 'Overpressure or pressure sensor fault',
    5: 'Low pressure',
    6: 'Overpressure',
    7: 'Phase loss (power phase loss)',
    8: 'Overheating',
    9: 'Power overload',
    10: 'Software current fault',
    11: 'Communication failure',
    12: 'Reserved',
    13: 'Motor locked',
    14: 'Motor phase loss',
    15: 'Motor overspeed',
    16: 'Memory failure (FLASH failure)'
};

// Standard Modbus RTU CRC-16 (polynomial 0xA001, transmitted low byte first).
function calculateCRC16(data: Buffer): number {
    let crc = 0xFFFF;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc & 0x0001) ? (crc >> 1) ^ 0xA001 : crc >> 1;
        }
    }
    return crc;
}

// Appends a little-endian CRC-16 to a frame body and returns the full frame.
function appendCRC(body: Buffer): Buffer {
    const frame = Buffer.alloc(body.length + 2);
    body.copy(frame);
    frame.writeUInt16LE(calculateCRC16(body), body.length);
    return frame;
}

// Reverse direction: builds valid Modbus RTU frames (CRC computed automatically).
class ModbusEncoder {
    public appendCRC(body: Buffer): Buffer {
        return appendCRC(body);
    }

    // Function 0x03 request: read `count` holding registers starting at `startAddress`.
    public encodeReadRequest(slave: number, startAddress: number, count: number): Buffer {
        const body = Buffer.alloc(6);
        body[0] = slave;
        body[1] = 0x03;
        body.writeUInt16BE(startAddress & 0xFFFF, 2);
        body.writeUInt16BE(count & 0xFFFF, 4);
        return appendCRC(body);
    }

    // Function 0x03 response: the register `values` (16-bit each) returned by the device.
    public encodeReadResponse(slave: number, values: number[]): Buffer {
        const byteCount = values.length * 2;
        const body = Buffer.alloc(3 + byteCount);
        body[0] = slave;
        body[1] = 0x03;
        body[2] = byteCount;
        values.forEach((v, i) => body.writeUInt16BE(v & 0xFFFF, 3 + i * 2));
        return appendCRC(body);
    }

    // Function 0x06: write a single register.
    public encodeWriteRequest(slave: number, address: number, value: number): Buffer {
        const body = Buffer.alloc(6);
        body[0] = slave;
        body[1] = 0x06;
        body.writeUInt16BE(address & 0xFFFF, 2);
        body.writeUInt16BE(value & 0xFFFF, 4);
        return appendCRC(body);
    }

    // Exception response (function code | 0x80).
    public encodeErrorResponse(slave: number, functionCode: number, exceptionCode: number): Buffer {
        const body = Buffer.alloc(3);
        body[0] = slave;
        body[1] = (functionCode | 0x80) & 0xFF;
        body[2] = exceptionCode;
        return appendCRC(body);
    }
}

class ModbusDecoder {
    private inputToBuffer(input: any): Buffer {
        if (Buffer.isBuffer(input)) {
            return input;
        } else if (typeof input === 'string') {
            const hexString = input.replace(/\s/g, '');
            if (hexString.length % 2 !== 0) {
                throw new Error('Invalid hex string length');
            }
            return Buffer.from(hexString, 'hex');
        } else if (Array.isArray(input)) {
            return Buffer.from(input);
        } else {
            throw new Error('Unsupported input type. Expected Buffer, hex string or number array.');
        }
    }

    private verifyCRC(data: Buffer): boolean {
        if (data.length < 2) return false;

        const messageWithoutCRC = data.slice(0, -2);
        const receivedCRC = data.readUInt16LE(data.length - 2);
        const calculatedCRC = calculateCRC16(messageWithoutCRC);

        return receivedCRC === calculatedCRC;
    }

    private decodeStatusRegister(status: number): any {
        // Per protocol: bit0 (RS) = run/stop, bit1 (LS) = water shortage.
        return {
            running: (status & 0x0001) !== 0,
            water_shortage: (status & 0x0002) !== 0,
            raw_value: status
        };
    }

    private decodeRegisterValue(register: ModbusRegister, rawValue: number): any {
        let value = rawValue;
        
        if (register.scale) {
            value = Number((rawValue * register.scale).toFixed(3));
        }
        
        switch (register.address) {
            case 6: // error_code
                return {
                    code: rawValue,
                    description: ERROR_CODES[rawValue] || 'Unknown error',
                    raw_value: rawValue
                };

            case 7: // status_code
                return this.decodeStatusRegister(rawValue);

            case 14: // carrier_frequency
                return {
                    value: rawValue === 72 ? 'H' : 'L',
                    code: rawValue,
                    raw_value: rawValue
                };

            case 0x1001: // status_command (4097)
                const statusMap: { [key: number]: string } = {
                    0x00: 'invalid',
                    0x01: 'running',
                    0x04: 'stop',
                    0x11: 'error reset'
                };
                return {
                    code: rawValue,
                    description: statusMap[rawValue] || 'Unknown status',
                    raw_value: rawValue
                };

            case 19: // measurement_range
                const rangeMap: { [key: number]: string } = {
                    6: '6 bar',
                    10: '10 bar',
                    16: '16 bar'
                };
                return {
                    value: rangeMap[rawValue] || `Unknown (${rawValue})`,
                    code: rawValue,
                    raw_value: rawValue
                };
        }
        
        return {
            value: value,
            raw_value: rawValue
        };
    }

    // `startAddress` is the address of the first register in a function 0x03 response.
    // The response frame itself does not carry it; the protocol's documented usage reads
    // from address 1, which is the default.
    public decodeModbusMessage(input: any, startAddress: number = 1): DecodedData {
        const buffer = this.inputToBuffer(input);

        if (buffer.length < 4) {
            throw new Error('Message too short');
        }

        if (!this.verifyCRC(buffer)) {
            throw new Error('CRC check failed');
        }
        
        const slaveAddress = buffer[0];
        const functionCode = buffer[1];
        
        const result: DecodedData = {
            slave_address: slaveAddress,
            function_code: functionCode,
            function_name: this.getFunctionName(functionCode),
            raw_data: buffer.toString('hex').toUpperCase(),
            timestamp: new Date().toISOString(),
            registers: {}
        };
        
        if (functionCode === 0x03) {
            const byteCount = buffer[2];
            const registerCount = byteCount / 2;
            
            for (let i = 0; i < registerCount; i++) {
                const registerValue = buffer.readUInt16BE(3 + i * 2);
                const registerAddress = startAddress + i;
                
                if (MODBUS_REGISTERS[registerAddress]) {
                    const register = MODBUS_REGISTERS[registerAddress];
                    const decodedValue = this.decodeRegisterValue(register, registerValue);

                    result.registers[register.name] = {
                        unit: register.unit,
                        description: register.description,
                        address: register.address,
                        read_only: register.readOnly,
                        // Decoded fields (e.g. a per-value description for error_code)
                        // take precedence over the register's static metadata.
                        ...decodedValue
                    };
                } else {
                    result.registers[`unknown_0x${registerAddress.toString(16).padStart(4, '0')}`] = {
                        value: registerValue,
                        raw_value: registerValue,
                        unit: 'unknown',
                        description: 'Unknown register',
                        address: registerAddress
                    };
                }
            }
        } else if (functionCode === 0x06) {
            const registerAddress = buffer.readUInt16BE(2);
            const registerValue = buffer.readUInt16BE(4);
            
            if (MODBUS_REGISTERS[registerAddress]) {
                const register = MODBUS_REGISTERS[registerAddress];
                const decodedValue = this.decodeRegisterValue(register, registerValue);

                result.registers[register.name] = {
                    unit: register.unit,
                    description: register.description,
                    address: registerAddress,
                    read_only: register.readOnly,
                    ...decodedValue,
                    operation: 'write'
                };
            }
        } else if (functionCode === 0x83) {
            const errorCode = buffer[2];
            const errorDescriptions: { [key: number]: string } = {
                1: 'Illegal Function',
                2: 'Illegal Data Address', 
                3: 'Illegal Data Value',
                4: 'Server Device Failure'
            };
            
            result.error = {
                code: errorCode,
                description: `Modbus Error: ${errorDescriptions[errorCode] || 'Unknown error'}`,
                modbus_error: true
            };
        }
        
        return result;
    }

    private getFunctionName(code: number): string {
        const functions: { [key: number]: string } = {
            3: 'Read Holding Registers',
            6: 'Write Single Register',
            131: 'Error Response'
        };
        return functions[code] || `Unknown (${code})`;
    }
}

const nodeRegistration = function(RED: NodeAPI) {
    function ErmangizerModbusNode(this: ErmangizerModbusNode, config: ErmangizerModbusNodeDef) {
        RED.nodes.createNode(this, config);
        
        this.name = config.name;
        this.inputType = config.inputType || 'auto';
        this.outputFormat = config.outputFormat || 'detailed';
        
        const decoder = new ModbusDecoder();

        this.on('input', (msg: NodeMessage, send: (msg: NodeMessage | NodeMessage[]) => void, done: (err?: Error) => void) => {
            const inputData = msg.payload;

            // Detect the format per message without mutating the node's configured
            // mode (otherwise the first message would lock auto-detection forever).
            let detectedType = this.inputType;
            if (detectedType === 'auto') {
                if (Buffer.isBuffer(inputData)) {
                    detectedType = 'buffer';
                } else if (typeof inputData === 'string' && /^[0-9a-fA-F\s]+$/.test(inputData)) {
                    detectedType = 'hexstring';
                } else if (Array.isArray(inputData)) {
                    detectedType = 'array';
                }
            }

            try {
                const decodedData = decoder.decodeModbusMessage(inputData);
                
                if (this.outputFormat === 'simplified') {
                    const simplified: any = {
                        slave: decodedData.slave_address,
                        function: decodedData.function_name,
                        timestamp: decodedData.timestamp
                    };
                    
                    // Simplified = one scalar per register: prefer `value`, then a
                    // decoded `code` (error_code, status_command), then `raw_value`
                    // (e.g. the status_code bitfield). Falls back to the object only
                    // if none of those exist.
                    Object.keys(decodedData.registers).forEach(key => {
                        const reg = decodedData.registers[key];
                        if (reg.value !== undefined) {
                            simplified[key] = reg.value;
                        } else if (reg.code !== undefined) {
                            simplified[key] = reg.code;
                        } else if (reg.raw_value !== undefined) {
                            simplified[key] = reg.raw_value;
                        } else {
                            simplified[key] = reg;
                        }
                    });
                    
                    if (decodedData.error) {
                        simplified.error = decodedData.error;
                    }
                    
                    msg.payload = simplified;
                } else {
                    msg.payload = decodedData;
                }
                
                msg.originalPayload = inputData;
                
                send(msg);
                done();
            } catch (error: any) {
                msg.payload = {
                    error: error.message,
                    input_type: detectedType,
                    original_data: msg.payload
                };
                msg.error = error;
                
                send(msg);
                done(error);
            }
        });
    }

    RED.nodes.registerType('ermangizer-modbus', ErmangizerModbusNode);
};

// Node-RED loads the module by calling the exported function. The decoder/encoder
// and protocol tables are attached for programmatic use and unit testing.
module.exports = nodeRegistration;
module.exports.ModbusDecoder = ModbusDecoder;
module.exports.ModbusEncoder = ModbusEncoder;
module.exports.MODBUS_REGISTERS = MODBUS_REGISTERS;
module.exports.ERROR_CODES = ERROR_CODES;
module.exports.calculateCRC16 = calculateCRC16;
module.exports.appendCRC = appendCRC;
