/**
 * Protobuf contracts, implemented with @bufbuild/protobuf.
 *
 * The JSON inventory contains names/tags/types only, not app code or credentials.
 * A descriptor is built at runtime from it, so ProtoJSON (RFC3339 timestamps, enum
 * names, oneofs, maps, proto3 optional) is handled by the protobuf runtime itself.
 * Unknown response fields are preserved in memory by the runtime.
 */
import {
  create,
  createFileRegistry,
  fromBinary,
  fromJson,
  toBinary,
  toJson,
  type DescMessage,
  type JsonValue,
  type Message,
  type MessageInitShape,
} from '@bufbuild/protobuf';
import {
  FieldDescriptorProto_Label as Label,
  FieldDescriptorProto_Type as Type,
  FileDescriptorProtoSchema,
  file_google_protobuf_timestamp,
  type DescriptorProtoSchema,
  type FieldDescriptorProtoSchema,
} from '@bufbuild/protobuf/wkt';

import schemaJson from './data/schema.json' with { type: 'json' };
import { FlightyError } from './errors.js';

type DescriptorInit = MessageInitShape<typeof DescriptorProtoSchema>;
type FieldInit = MessageInitShape<typeof FieldDescriptorProtoSchema>;

export interface SchemaField {
  number: number;
  name: string;
  json_name: string;
  repeated: boolean;
  optional: boolean;
  type: string;
  oneof?: string;
  value_type?: string;
}
export type SchemaEntry =
  | { kind: 'message'; fields: SchemaField[] }
  | { kind: 'enum'; values: Record<string, number> };

export const SCHEMA = schemaJson as unknown as Record<string, SchemaEntry>;

const SCALARS: Record<string, Type> = {
  string: Type.STRING,
  bytes: Type.BYTES,
  bool: Type.BOOL,
  double: Type.DOUBLE,
  float: Type.FLOAT,
  int32: Type.INT32,
  int64: Type.INT64,
  uint32: Type.UINT32,
  uint64: Type.UINT64,
};

const identifier = (name: string) => name.replaceAll('.', '__');

function fieldType(typename: string): Pick<FieldInit, 'type' | 'typeName'> {
  if (typename in SCALARS) return { type: SCALARS[typename], typeName: '' };
  if (typename.startsWith('google.protobuf.')) return { type: Type.MESSAGE, typeName: '.' + typename };
  const definition = SCHEMA[typename];
  if (!definition) throw new Error(`Schema references unknown type ${typename}`);
  return definition.kind === 'enum'
    ? { type: Type.ENUM, typeName: `.flighty.${identifier(typename)}.Value` }
    : { type: Type.MESSAGE, typeName: `.flighty.${identifier(typename)}` };
}

function buildRegistry() {
  const messageType: DescriptorInit[] = [];
  for (const [name, definition] of Object.entries(SCHEMA)) {
    const id = identifier(name);
    if (definition.kind === 'enum') {
      // Every enum is wrapped in its own message so value names never collide.
      const values = Object.entries(definition.values).sort((a, b) => a[1] - b[1]);
      messageType.push({
        name: id,
        enumType: [{
          name: 'Value',
          value: values.map(([symbol, number]) => ({ name: symbol, number })),
          options: { allowAlias: new Set(values.map((v) => v[1])).size !== values.length },
        }],
      });
      continue;
    }
    const groups = [...new Set(definition.fields.flatMap((f) => (f.oneof ? [f.oneof] : [])))];
    const oneofDecl = groups.map((g) => ({ name: g }));
    const nestedType: DescriptorInit[] = [];
    const field: FieldInit[] = [];
    for (const entry of definition.fields) {
      const f: FieldInit = {
        name: entry.name,
        jsonName: entry.json_name,
        number: entry.number,
        label: entry.repeated ? Label.REPEATED : Label.OPTIONAL,
      };
      if (entry.type === 'map') {
        const mapName = 'Map_' + entry.name;
        nestedType.push({
          name: mapName,
          options: { mapEntry: true },
          field: [
            { name: 'key', jsonName: 'key', number: 1, label: Label.OPTIONAL, ...fieldType('string') },
            { name: 'value', jsonName: 'value', number: 2, label: Label.OPTIONAL, ...fieldType(entry.value_type!) },
          ],
        });
        Object.assign(f, { label: Label.REPEATED, type: Type.MESSAGE, typeName: `.flighty.${id}.${mapName}` });
      } else {
        Object.assign(f, fieldType(entry.type));
      }
      if (entry.oneof) {
        f.oneofIndex = groups.indexOf(entry.oneof);
      } else if (entry.optional && !entry.repeated && f.type !== Type.MESSAGE) {
        // Explicitly-present false, zero and empty string must survive encoding.
        f.oneofIndex = oneofDecl.length;
        oneofDecl.push({ name: '_optional_' + entry.name });
        f.proto3Optional = true;
      }
      field.push(f);
    }
    messageType.push({ name: id, field, nestedType, oneofDecl });
  }
  const file = create(FileDescriptorProtoSchema, {
    name: 'flighty.proto',
    package: 'flighty',
    syntax: 'proto3',
    dependency: ['google/protobuf/timestamp.proto'],
    messageType,
  });
  return createFileRegistry(file, (name) => (name === 'google/protobuf/timestamp.proto' ? file_google_protobuf_timestamp : undefined));
}

let _registry: ReturnType<typeof buildRegistry> | null = null;
function registry() {
  return (_registry ??= buildRegistry());
}

export function messageSchema(name: string): DescMessage {
  const definition = SCHEMA[name];
  if (!definition || definition.kind !== 'message') {
    throw new FlightyError('Unknown supported protobuf message. Use get_schema to list names.');
  }
  const desc = registry().getMessage('flighty.' + identifier(name));
  if (!desc) throw new FlightyError('Unknown supported protobuf message. Use get_schema to list names.');
  return desc;
}

/** Strict ProtoJSON input: reject unknown fields and invalid oneof combinations. */
export function encode(name: string, payload: unknown): Uint8Array {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new FlightyError('Protobuf payload must be a JSON object.');
  }
  const schema = messageSchema(name);
  try {
    const message = fromJson(schema, payload as JsonValue, { ignoreUnknownFields: false });
    return toBinary(schema, message);
  } catch {
    // Parser errors may contain actual credential/receipt bytes supplied by a caller.
    throw new FlightyError(`Payload does not match ${name}. Use get_schema for fields, types and oneofs.`);
  }
}

export function parse(name: string, data: Uint8Array): { schema: DescMessage; message: Message } {
  const schema = messageSchema(name);
  try {
    return { schema, message: fromBinary(schema, data) };
  } catch {
    throw new FlightyError(`Response does not match supported ${name} protobuf.`);
  }
}

/** Return canonical ProtoJSON, including RFC3339 timestamps and enum names. */
export function asDict(parsed: { schema: DescMessage; message: Message }): Record<string, any> {
  return toJson(parsed.schema, parsed.message, { registry: registry() }) as Record<string, any>;
}

export function decode(name: string, data: Uint8Array): Record<string, any> {
  return asDict(parse(name, data));
}

export function unknownFieldsPresent(parsed: { schema: DescMessage; message: Message }): boolean {
  const known = toBinary(parsed.schema, parsed.message, { writeUnknownFields: false });
  const all = toBinary(parsed.schema, parsed.message);
  if (known.length !== all.length) return true;
  for (let i = 0; i < known.length; i++) if (known[i] !== all[i]) return true;
  return false;
}

/** Expose the exact supported request/response field contract to an MCP client. */
export function describe(name: string): Record<string, unknown> {
  if (!(name in SCHEMA)) {
    const needle = name.toLowerCase();
    const matches = Object.keys(SCHEMA).filter((n) => n.toLowerCase().includes(needle));
    return { matches, count: matches.length };
  }
  return { name, ...SCHEMA[name] };
}

const SECRET_FIELDS = /(?:token|secret|receipt|password|authorization|imageData)/i;

/** Never return account/device tokens, invitation secrets, or receipt data. */
export function redact(value: unknown): any {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, SECRET_FIELDS.test(key) ? '[REDACTED]' : redact(item)]),
    );
  }
  return value;
}
