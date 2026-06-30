# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Что это

Один кастомный узел Node-RED (`ermangizer-modbus`), который декодирует сообщения Modbus RTU частотного преобразователя ERMANGIZER в структурированный JSON. Это опубликованный npm-пакет (`node-red-ermangizer-modbus`); пользователи устанавливают его в `~/.node-red` и подключают в свои flow.

## Сборка

```bash
npm run build      # tsc — компилирует src/ermangizer-modbus.ts -> ./ermangizer-modbus.js
npm run dev        # tsc --watch
npm test           # pretest гоняет tsc, затем node test/test.js (без внешних зависимостей)
```

Линтера и CI нет. Тесты — `test/test.js`: проверяют CRC-16 на эталонных кадрах из PDF, декод всех регистров и round-trip энкод→декод. **Запускайте `npm test` после любых правок логики.** Спецификация протокола лежит в `doc/protocol_modbus_eg-g-220-03.pdf` (редакция 2026) и является источником истины для адресов регистров, масштабов (scale) и кодов.

## Важная деталь сборки

В `tsconfig.json` заданы `outDir: "./"` и `rootDir: "./src"`, поэтому `tsc` выкладывает скомпилированный JS **в корень репозитория** как `ermangizer-modbus.js`. Этот файл закоммичен и именно его реально загружает Node-RED (см. `package.json` → `node-red.nodes`). **`ermangizer-modbus.js` — сгенерированный файл, никогда не правьте его вручную. Редактируйте `src/ermangizer-modbus.ts` и запускайте `npm run build`.**

## Архитектура

Узел состоит из трёх связанных файлов, которые должны оставаться синхронными:

- **`src/ermangizer-modbus.ts`** — вся логика декодирования. Компилируется в `ermangizer-modbus.js`.
- **`ermangizer-modbus.html`** — UI редактора Node-RED: регистрация (категория `parser`), форма настроек (`name`, `inputType`, `outputFormat`) и панель справки.
- **`locales/en-US/ermangizer-modbus.json`** — i18n-метки, на которые ссылается HTML.

Добавление поля настройки означает правку defaults в TS, `defaults`/формы в HTML и locale-файла — всё вместе.

### Конвейер декодирования (в `src/ermangizer-modbus.ts`)

`ModbusDecoder.decodeModbusMessage(input, startAddress = 1)` — ядро. Поток:

1. `inputToBuffer()` нормализует три принимаемых формата `msg.payload` — `Buffer`, hex-строку (пробелы удаляются) или массив чисел — в `Buffer`. Автоопределение в обработчике `input` выбирает тип, когда `inputType === 'auto'` (через локальную переменную, **без мутации** `this.inputType`).
2. `verifyCRC()` проверяет Modbus CRC-16 (общая функция `calculateCRC16`, полином `0xA001`, CRC в конце в little-endian). Ошибка бросает исключение и возвращается как error-payload.
3. Ветвление по коду функции:
   - `0x03` Read Holding Registers — читает `byteCount/2` регистров, начиная с `startAddress` (по умолчанию 1) и последовательно увеличивая. Адрес из ответа-фрейма не берётся (его там нет); документированное использование — чтение с адреса 1.
   - `0x06` Write Single Register — читает целевой адрес из фрейма.
   - `0x83` — ответ-исключение Modbus.
4. `decodeRegisterValue()` применяет `scale` по каждому регистру и особым образом обрабатывает отдельные адреса (код ошибки `6`, битовое поле статуса `7`, несущая частота `14`, диапазон измерения `19`, командный статус `0x1001`), превращая их в более развёрнутые объекты.

> При сборке итогового объекта регистра метаданные пишутся первыми, затем `...decodedValue` — **декодированные поля имеют приоритет** (например, описание `error_code` «No error» не должно затираться статическим `description` регистра).

### Энкодер (обратное направление)

`ModbusEncoder` строит валидные кадры с автоматическим CRC: `encodeReadRequest`, `encodeReadResponse`, `encodeWriteRequest`, `encodeErrorResponse`, `appendCRC`. Используется для генерации запросов и тест-фикстур.

Модуль экспортирует функцию-регистрацию Node-RED, а также `ModbusDecoder`, `ModbusEncoder`, `MODBUS_REGISTERS`, `ERROR_CODES`, `calculateCRC16`, `appendCRC` (для программного использования и тестов).

### Таблицы регистров / кодов

`MODBUS_REGISTERS`, `ERROR_CODES` и встроенные карты статусов/диапазонов — это данные протокола. **Адреса регистров ДЕСЯТИЧНЫЕ** (мониторинг — 1–22; управляющие регистры — 4096/4097 = `0x1000`/`0x1001`, в таком виде они идут по проводу). Раньше RW-регистры ошибочно были ключами `0x0010`–`0x0022` (= дес. 16–34), из-за чего регистры 10–22 декодировались как `unknown`. Каждая запись регистра содержит `name`, `unit`, `description`, `readOnly` и опциональный `scale`.

### Контракт вывода

- **detailed** (по умолчанию): полный объект — `slave_address`, `function_code`, `function_name`, `raw_data`, `timestamp` и карта `registers` с полностью аннотированными значениями.
- **simplified**: каждый регистр сводится к скалярному `value` (или к под-объекту, если простого значения нет), плюс `slave`/`function`/`timestamp`.

При ошибке узел устанавливает `msg.payload` в объект ошибки, выставляет `msg.error`, всё равно вызывает `send(msg)`, а затем `done(error)`. Исходный ввод сохраняется в `msg.originalPayload`.

## Версионирование / публикация

Поднимите `version` в `package.json`, запустите `npm run build`, чтобы закоммиченный `ermangizer-modbus.js` соответствовал исходнику, затем публикуйте. README документирует полный набор регистров и форматы сообщений для конечных пользователей.
