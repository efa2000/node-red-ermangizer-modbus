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

const MODBUS_REGISTERS: { [key: number]: ModbusRegister } = {
    // Read-only registers (0x0001-0x0007)
    0x0001: { address: 0x0001, name: 'output_frequency', unit: '0.1 Hz', description: 'Current output frequency value', readOnly: true, scale: 0.1 },
    0x0002: { address: 0x0002, name: 'output_current', unit: '0.1 A', description: 'Current output current value', readOnly: true, scale: 0.1 },
    0x0003: { address: 0x0003, name: 'input_voltage', unit: 'V', description: 'Current input voltage value', readOnly: true },
    0x0004: { address: 0x0004, name: 'temperature', unit: '°C', description: 'Current temperature display', readOnly: true },
    0x0005: { address: 0x0005, name: 'pressure', unit: '0.01 bar', description: 'Actual pressure value', readOnly: true, scale: 0.01 },
    0x0006: { address: 0x0006, name: 'error_code', unit: '', description: 'Error code', readOnly: true },
    0x0007: { address: 0x0007, name: 'status_code', unit: '', description: 'Status code', readOnly: true },
    
    // Read-write registers (0x0010-0x0022)
    0x0010: { address: 0x0010, name: 'factory_reset', unit: '', description: 'Restore factory settings', readOnly: false },
    0x0011: { address: 0x0011, name: 'initial_pressure_diff', unit: '0.01 bar', description: 'Initial pressure difference', readOnly: false, scale: 0.01 },
    0x0012: { address: 0x0012, name: 'water_shortage_pressure', unit: '0.01 bar', description: 'Pressure value during water shortage', readOnly: false, scale: 0.01 },
    0x0013: { address: 0x0013, name: 'water_shortage_time', unit: 's', description: 'Water shortage time', readOnly: false },
    0x0014: { address: 0x0014, name: 'carrier_frequency', unit: '', description: 'Carrier frequency', readOnly: false },
    0x0015: { address: 0x0015, name: 'accel_decel_time', unit: '0.1 ms', description: 'Acceleration and deceleration time', readOnly: false, scale: 0.1 },
    0x0016: { address: 0x0016, name: 'pressure_tolerance', unit: '0.01 bar', description: 'Allowable pressure error', readOnly: false, scale: 0.01 },
    0x0017: { address: 0x0017, name: 'min_shutdown_freq', unit: '0.1 Hz', description: 'Minimum shutdown frequency', readOnly: false, scale: 0.1 },
    0x0018: { address: 0x0018, name: 'continuous_operation', unit: '', description: 'Enable continuous operation', readOnly: false },
    0x0019: { address: 0x0019, name: 'measurement_range', unit: 'bar', description: 'Measurement range selection', readOnly: false },
    0x0020: { address: 0x0020, name: 'overheat_setting', unit: '°C', description: 'Overheat setting', readOnly: false },
    0x0021: { address: 0x0021, name: 'direction_setting', unit: '', description: 'Set direction', readOnly: false },
    0x0022: { address: 0x0022, name: 'local_address', unit: '', description: 'Local address', readOnly: false },
    
    // Additional registers
    0x1000: { address: 0x1000, name: 'set_pressure', unit: '0.01 BAR', description: 'Set pressure value', readOnly: false, scale: 0.01 },
    0x1001: { address: 0x1001, name: 'status_command', unit: '', description: 'Command status code', readOnly: false }
};

const ERROR_CODES: { [key: number]: string } = {
    0: 'No error',
    1: 'Equipment overcurrent, short circuit',
    2: 'Overload',
    3: 'Low pressure (no pressure sensor)',
    4: 'Overpressure',
    5: 'Low pressure',
    6: 'Overpressure',
    7: 'Phase loss (power phase loss)',
    8: 'Overheating',
    9: 'Insufficient power',
    10: 'Software current overload',
    11: 'Communication failure',
    12: 'Default',
    13: 'Motor locked',
    14: 'Motor phase loss',
    15: 'Motor overspeed',
    16: 'Memory failure (FLASH failure)'
};

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

    private calculateCRC16(data: Buffer): number {
        let crc = 0xFFFF;
        for (let i = 0; i < data.length; i++) {
            crc ^= data[i];
            for (let j = 0; j < 8; j++) {
                if (crc & 0x0001) {
                    crc = (crc >> 1) ^ 0xA001;
                } else {
                    crc = crc >> 1;
                }
            }
        }
        return crc;
    }

    private verifyCRC(data: Buffer): boolean {
        if (data.length < 2) return false;
        
        const messageWithoutCRC = data.slice(0, -2);
        const receivedCRC = data.readUInt16LE(data.length - 2);
        const calculatedCRC = this.calculateCRC16(messageWithoutCRC);
        
        return receivedCRC === calculatedCRC;
    }

    private decodeStatusRegister(status: number): any {
        return {
            water_shortage: (status & 0x0001) !== 0,
            running: (status & 0x0002) !== 0,
            raw_value: status
        };
    }

    private decodeRegisterValue(register: ModbusRegister, rawValue: number): any {
        let value = rawValue;
        
        if (register.scale) {
            value = Number((rawValue * register.scale).toFixed(3));
        }
        
        switch (register.address) {
            case 0x0006:
                return {
                    code: rawValue,
                    description: ERROR_CODES[rawValue] || 'Unknown error',
                    raw_value: rawValue
                };
            
            case 0x0007:
                return this.decodeStatusRegister(rawValue);
            
            case 0x0014:
                return {
                    value: rawValue === 72 ? 'H' : 'L',
                    code: rawValue,
                    raw_value: rawValue
                };
            
            case 0x1001:
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

            case 0x0019:
                const rangeMap: { [key: number]: string } = {
                    6: '6 bar',
                    10: '10 bar',
                    16: '16 bar',
                    25: '25 bar'
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

    public decodeModbusMessage(input: any): DecodedData {
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
                const registerAddress = 0x0001 + i;
                
                if (MODBUS_REGISTERS[registerAddress]) {
                    const register = MODBUS_REGISTERS[registerAddress];
                    const decodedValue = this.decodeRegisterValue(register, registerValue);
                    
                    result.registers[register.name] = {
                        ...decodedValue,
                        unit: register.unit,
                        description: register.description,
                        address: register.address,
                        read_only: register.readOnly
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
                    ...decodedValue,
                    unit: register.unit,
                    description: register.description,
                    address: registerAddress,
                    read_only: register.readOnly,
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

module.exports = function(RED: NodeAPI) {
    function ErmangizerModbusNode(this: ErmangizerModbusNode, config: ErmangizerModbusNodeDef) {
        RED.nodes.createNode(this, config);
        
        this.name = config.name;
        this.inputType = config.inputType || 'auto';
        this.outputFormat = config.outputFormat || 'detailed';
        
        const decoder = new ModbusDecoder();

        this.on('input', (msg: NodeMessage, send: (msg: NodeMessage | NodeMessage[]) => void, done: (err?: Error) => void) => {
            try {
                let inputData = msg.payload;
                
                if (this.inputType === 'auto') {
                    if (Buffer.isBuffer(inputData)) {
                        this.inputType = 'buffer';
                    } else if (typeof inputData === 'string' && /^[0-9a-fA-F\s]+$/.test(inputData)) {
                        this.inputType = 'hexstring';
                    } else if (Array.isArray(inputData)) {
                        this.inputType = 'array';
                    }
                }
                
                const decodedData = decoder.decodeModbusMessage(inputData);
                
                if (this.outputFormat === 'simplified') {
                    const simplified: any = {
                        slave: decodedData.slave_address,
                        function: decodedData.function_name,
                        timestamp: decodedData.timestamp
                    };
                    
                    Object.keys(decodedData.registers).forEach(key => {
                        const reg = decodedData.registers[key];
                        simplified[key] = reg.value !== undefined ? reg.value : reg;
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
                    input_type: this.inputType,
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
