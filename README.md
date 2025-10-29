# Node-RED ERMANGIZER Modbus Node

A custom Node-RED node for decoding ERMANGIZER frequency converter Modbus RTU protocol messages according to the official protocol specification.

## Features

- 🚀 **Multiple Input Formats**: Supports Buffer, Hex String, and Number Array inputs
- 🔍 **Auto Detection**: Automatic input type detection
- 📊 **Two Output Formats**: Detailed (full metadata) and Simplified (values only)
- ✅ **CRC Verification**: Ensures data integrity with CRC-16 checks
- 🛡️ **Error Handling**: Comprehensive error handling with descriptive messages
- 📋 **Complete Protocol Support**: Decodes all registers from the ERMANGIZER protocol
- 🌐 **TypeScript**: Written in TypeScript for better maintainability

## Supported Registers

The node decodes all registers defined in the ERMANGIZER Modbus RTU protocol:

### Read-Only Registers
- `output_frequency` - Current output frequency (0.1 Hz)
- `output_current` - Current output current (0.1 A)
- `input_voltage` - Current input voltage (V)
- `temperature` - Current temperature (°C)
- `pressure` - Actual pressure value (0.01 bar)
- `error_code` - Error code with descriptions
- `status_code` - Status code with bit-level decoding

### Read-Write Registers
- `factory_reset` - Restore factory settings
- `initial_pressure_diff` - Initial pressure difference (0.01 bar)
- `water_shortage_pressure` - Pressure value during water shortage (0.01 bar)
- `water_shortage_time` - Water shortage time (s)
- `carrier_frequency` - Carrier frequency selection
- `accel_decel_time` - Acceleration and deceleration time (0.1 ms)
- `pressure_tolerance` - Allowable pressure error (0.01 bar)
- `min_shutdown_freq` - Minimum shutdown frequency (0.1 Hz)
- `continuous_operation` - Enable continuous operation
- `measurement_range` - Measurement range selection (bar)
- `overheat_setting` - Overheat setting (°C)
- `direction_setting` - Set rotation direction
- `local_address` - Local Modbus address

### Control Registers
- `set_pressure` - Set pressure value (0.01 BAR)
- `status_command` - Command status code

## Installation
### npm Installation

```bash
cd ~/.node-red
npm install node-red-ermangizer-modbus
```

Then restart Node-RED.

## Usage

### Basic Setup

1. **Add the node** to your flow from the palette (category: "parser")
2. **Configure settings**:
   - **Name**: Optional node name
   - **Input Type**: Auto-detect or specify format
   - **Output Format**: Choose between Detailed or Simplified
3. **Connect input**: Connect to any node that outputs Modbus RTU data
4. **Connect output**: Process the decoded data in subsequent nodes

### Input Formats

The node accepts three input formats:

#### 1. Buffer (Recommended)
```javascript
// From serial port or TCP Modbus connection
msg.payload = buffer; // Raw Buffer object
```

#### 2. Hex String
```javascript
// Hexadecimal string (spaces optional)
msg.payload = "3f0300010016911a";
// or
msg.payload = "3f 03 00 01 00 16 91 1a";
```

#### 3. Number Array
```javascript
// Array of byte values
msg.payload = [0x3f, 0x03, 0x00, 0x01, 0x00, 0x16, 0x91, 0x1a];
```

### Output Formats

#### Detailed Format (Default)
```javascript
{
  "slave_address": 63,
  "function_code": 3,
  "function_name": "Read Holding Registers",
  "raw_data": "3F0300010016911A",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "registers": {
    "output_frequency": {
      "value": 50.0,
      "raw_value": 500,
      "unit": "0.1 Hz",
      "description": "Current output frequency value",
      "address": 1,
      "read_only": true
    },
    "error_code": {
      "code": 0,
      "description": "No error",
      "raw_value": 0
    }
    // ... more registers
  }
}
```

#### Simplified Format
```javascript
{
  "slave": 63,
  "function": "Read Holding Registers",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "output_frequency": 50.0,
  "error_code": 0,
  "temperature": 45,
  "pressure": 2.5
  // ... more register values
}
```

## Examples

### Example 1: Reading Multiple Registers
```javascript
// Input message (hex string example)
msg.payload = "3f03002c3f032c01f4000100ea0020000000000001000000000001001e000a001e004c0014000a00f00000000600550000003f38ee";

// Output (simplified format):
{
  "slave": 63,
  "function": "Read Holding Registers",
  "output_frequency": 50.0,
  "output_current": 5.0,
  "input_voltage": 234,
  "temperature": 32,
  "pressure": 0.0,
  "error_code": 0,
  "status_code": 0
}
```
### Example 2: Error Response
```javascript
// Error response example
msg.payload = "3f8302a13d";

// Output:
{
  "slave_address": 63,
  "function_code": 131,
  "function_name": "Error Response",
  "error": {
    "code": 2,
    "description": "Modbus Error: Illegal Data Address",
    "modbus_error": true
  }
}
```

## Error Codes

The node decodes all ERMANGIZER error codes:

| Code | Description |
|------|-------------|
| 0 | No error |
| 1 | Equipment overcurrent, short circuit |
| 2 | Overload |
| 3 | Low pressure (no pressure sensor) |
| 4 | Overpressure |
| 5 | Low pressure |
| 6 | Overpressure |
| 7 | Phase loss (power phase loss) |
| 8 | Overheating |
| 9 | Insufficient power |
| 10 | Software current overload |
| 11 | Communication failure |
| 12 | Default |
| 13 | Motor locked |
| 14 | Motor phase loss |
| 15 | Motor overspeed |
| 16 | Memory failure (FLASH failure) |

## Status Code Decoding

The status register (0x0007) is decoded into individual bits:

```javascript
{
  "water_shortage": false,  // Bit 0: 0=no water shortage, 1=water shortage
  "running": true,          // Bit 1: 0=stopped, 1=running
  "raw_value": 2           // Original register value
}
```

## Building from Source

If you're modifying the TypeScript source:

1. Install dependencies:
   ```bash
   npm install
   ```

2. Build the project:
   ```bash
   npm run build
   ```

3. For development with auto-rebuild:
   ```bash
   npm run dev
   ```

## Troubleshooting

### Common Issues

1. **"CRC check failed"**
   - Verify the Modbus message is complete and uncorrupted
   - Check that the entire message including CRC is provided

2. **"Message too short"**
   - Ensure the input contains at least 4 bytes (address + function code + CRC)

3. **"Unsupported input type"**
   - Use one of the supported formats: Buffer, hex string, or number array
   - Enable auto-detection if unsure of the format

4. **Node not appearing in palette**
   - Check that all files are in the correct location
   - Verify there are no syntax errors in the files
   - Restart Node-RED completely

### Debugging

Enable Node-RED debug output to see detailed processing information:

1. Add a debug node connected to the ERMANGIZER Modbus node output
2. Set debug to display complete message object
3. Check the Node-RED logs for any error messages

## Protocol Reference

This node implements the ERMANGIZER Modbus RTU protocol as specified in:
- **Document**: `protocol_modbus_eg-g-220-03.pdf` https://www.ermangizer.ru/image/pdf/protocol_modbus_eg-g-220-03.pdf
- **Baud Rate**: 9600
- **Data Bits**: 8 bits + 1 stop bit
- **Parity**: None
- **Device Address Range**: 1-63
- **Default Address**: 63

## License

This project is licensed under the MIT License.

## Support

For issues and feature requests, please contact the maintainers or refer to the ERMANGIZER protocol documentation.

## Changelog

### v1.0.0
- Initial release
- Support for all ERMANGIZER Modbus registers
- Multiple input format support
- CRC verification
- Comprehensive error handling

