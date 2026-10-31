/** Errors whose messages are safe to show to MCP clients. The SDK returns thrown messages as isError tool results. */
export class FlightyError extends Error {
  constructor(message: string) { super(message); this.name = 'FlightyError'; }
}

/** A mutation was refused before making an upstream request. */
export class WritesDisabled extends FlightyError {
  constructor(message: string) { super(message); this.name = 'WritesDisabled'; }
}
