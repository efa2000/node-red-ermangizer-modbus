[Русский](README.md) · **English**

# Node-RED ERMANGIZER Modbus Node

A custom Node-RED node for decoding ERMANGIZER (ER-G-220-03, ER-G-220-04, ER-G-380-02) frequency converter Modbus RTU protocol messages according to the official protocol specification.

## Features

- 🚀 **Multiple Input Formats**: Supports Buffer, Hex String, and Number Array inputs
- 🔍 **Auto Detection**: Automatic input type detection
- 📊 **Two Output Formats**: Detailed (full metadata) and Simplified (values only)
- ✅ **CRC Verification**: Ensures data integrity with CRC-16 checks
- 🛡️ **Error Handling**: Comprehensive error handling with descriptive messages
- 📤 **Command Encoder Node**: Build Modbus frames from human-friendly commands (`{command:"start"}`, `{write:"set_pressure", value:3.5}`) — no hand-crafted hex
- 📋 **Complete Protocol Support**: Decodes all registers from the ERMANGIZER protocol
- 🌐 **Localized**: English and Russian editor help and labels
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
- `initial_pressure_diff` - Pressure difference for sleep/wake (exit) mode (0.01 bar)
- `water_shortage_pressure` - Dry-run pressure value (0.01 bar)
- `water_shortage_time` - Dry-run time (s)
- `carrier_frequency` - Carrier frequency (see manual param P014)
- `accel_decel_time` - Acceleration and deceleration time (0.1 ms)
- `pressure_tolerance` - Allowable pressure error (0.01 bar)
- `min_shutdown_freq` - Minimum frequency (0.1 Hz)
- `continuous_operation` - Disable sleep mode (continuous operation)
- `measurement_range` - Pressure sensor range selection (bar)
- `overheat_setting` - Temperature alarm threshold (°C)
- `direction_setting` - Rotation direction (for ER-G-380-02)
- `local_address` - Local Modbus address

> **Note:** Register output keys (e.g. `water_shortage_pressure`, `continuous_operation`) are kept stable for backward compatibility; their descriptions follow the 2026 protocol revision, where some were reworded (water-shortage → dry-run, continuous-operation ↔ disable-sleep).

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

## Sending Commands (`ermangizer-modbus-encode` node)

The companion **ERMANGIZER Encode** node turns a human-friendly command object
into a ready-to-send Modbus RTU frame (CRC included) — no need to hand-build hex
strings. Wire its output into your serial/Modbus-out node.

Set `msg.payload` to one of:

```javascript
// Semantic commands (write register 0x1001)
{ command: "start" }                       // run
{ command: "stop" }                        // stop
{ command: "reset_error" }                 // clear fault
{ command: "set_pressure", value: 3.5 }    // set-point in bar

// Write any read-write register by name (value in engineering units)
{ write: "min_shutdown_freq", value: 30 }  // 30 Hz  -> raw 300 (scale 0.1)
{ write: "measurement_range", value: 10 }  // 10 bar sensor
{ write: "carrier_frequency", value: "H" } // 'H' or a raw numeric code

// Build a read request (function 0x03)
{ read: "all" }                            // addresses 1..22
{ read: "monitoring" }                     // addresses 1..7
{ read: ["output_frequency", "pressure"] } // smallest range covering the names
{ read: { start: 11, count: 4 } }          // explicit range
```

The register **scale is applied automatically** (e.g. bar → 0.01 bar units), and
writes to read-only registers, unknown names, or out-of-range values are rejected
with a clear error. An optional `slave` field overrides the node's configured
address for a single message: `{ command: "start", slave: 12 }`.

### Node settings

- **Slave** — default slave address (0–247). Defaults to `1`; **the ERMANGIZER
  factory address is `63`**, so set this to match your device.
- **Output** — `Buffer` (default) or uppercase `Hex String`.

### Pairing reads with the decoder

For `read` commands the node also sets `msg.modbus_start_address` to the first
requested address. Pass that message through to the **ERMANGIZER Modbus** decoder
node and it will map the response registers to the correct addresses (the decoder
defaults to address 1 when `msg.modbus_start_address` is absent).

### Programmatic use

```javascript
const { ModbusCommandEncoder } = require('node-red-ermangizer-modbus/ermangizer-modbus-encode');
const cmd = new ModbusCommandEncoder();

cmd.encode({ command: "start" }, 0x3F).frame;          // Buffer, slave 63
cmd.encode({ write: "set_pressure", value: 4.0 }).frame;
cmd.encode({ read: "all", slave: 0x3F });              // { frame, function_code, start_address, description }
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
| 2 | Power overload |
| 3 | Pressure sensor fault or incorrect connection |
| 4 | Overpressure or pressure sensor fault |
| 5 | Low pressure |
| 6 | Overpressure |
| 7 | Phase loss (power phase loss) |
| 8 | Overheating |
| 9 | Power overload |
| 10 | Software current fault |
| 11 | Communication failure |
| 12 | Reserved |
| 13 | Motor locked |
| 14 | Motor phase loss |
| 15 | Motor overspeed |
| 16 | Memory failure (FLASH failure) |

## Status Code Decoding

The status register (0x0007) is decoded into individual bits:

```javascript
{
  "running": true,          // Bit 0 (RS): 0=stopped, 1=running
  "water_shortage": false,  // Bit 1 (LS): 0=no water shortage, 1=water shortage
  "raw_value": 1           // Original register value
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

## Testing

The package ships with a dependency-free test suite (`test/test.js`) that validates
CRC-16 against the official documented frames, decoding of every register, and
encode→decode round-trips:

```bash
npm test   # runs `tsc` then executes the suite
```

## Building Frames (encoder)

In addition to decoding, the module exports a `ModbusEncoder` that builds valid
frames with the CRC computed automatically — useful for generating requests or
test fixtures:

```javascript
const { ModbusEncoder } = require('node-red-ermangizer-modbus');
const enc = new ModbusEncoder();

enc.encodeReadRequest(0x3F, 1, 22);        // read 22 registers from address 1
enc.encodeWriteRequest(0x3F, 0x1000, 400); // set pressure to 4.00 bar
enc.appendCRC(Buffer.from([0x3f, 0x06]));  // append a CRC-16 to any frame body
```

The `ModbusDecoder`, `MODBUS_REGISTERS`, `ERROR_CODES`, `calculateCRC16` and
`appendCRC` helpers are exported as well.

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

This node implements the ERMANGIZER Modbus RTU protocol (ER-G-220-03, ER-G-220-04, ER-G-380-02; 2026 revision) as specified in:
- **Document**: `protocol_modbus_eg-g-220-03.pdf` — https://www.ermangizer.ru/docs/220-03/protocol_modbus_eg-g-220-03.pdf (see also https://www.ermangizer.ru/documentation.html)
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

### v1.2.0
- Added the **`ermangizer-modbus-encode`** node: build Modbus RTU frames from
  human-friendly commands (`{command:"start"}`, `{write:"set_pressure", value:3.5}`,
  `{read:"all"}`) instead of hand-crafted hex strings — CRC and register scaling
  handled automatically
- Output as Buffer or hex string; per-message `slave` override
- Read commands set `msg.modbus_start_address`; the decoder node now honors it so
  reads from any address decode to the right register names
- Exposes `ModbusCommandEncoder` for programmatic use
- Added Russian (`ru`) editor localization for both nodes; README now available in
  Russian (default) and English

### v1.1.0
- Aligned with the 2026 protocol revision (ER-G-220-03 / ER-G-220-04 / ER-G-380-02); updated register descriptions and error codes
- **Fix:** register addresses are decimal (1–22) — read/write registers 10–22 previously decoded as `unknown`
- **Fix:** status bits were swapped (bit0=running, bit1=water shortage)
- **Fix:** decoded descriptions (e.g. `error_code` "No error") no longer overwritten by static metadata
- **Fix:** auto-detect no longer permanently locks the node's input format after the first message
- Simplified output now emits a scalar per register (value → code → raw_value)
- Added `ModbusEncoder` for building valid frames with automatic CRC
- Added a dependency-free test suite (`npm test`)

### v1.0.0
- Initial release
- Support for all ERMANGIZER Modbus registers
- Multiple input format support
- CRC verification
- Comprehensive error handling
