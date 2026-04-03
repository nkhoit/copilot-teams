import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

/**
 * Mock CopilotSession for testing.
 * Records all messages sent to it and provides inspection helpers.
 */
export class MockCopilotSession extends EventEmitter {
  readonly sessionId: string;
  readonly messages: Array<{ prompt: string; timestamp: number }> = [];
  private _disconnected = false;

  constructor(sessionId?: string) {
    super();
    this.sessionId = sessionId ?? randomUUID();
  }

  async send(opts: { prompt: string }): Promise<void> {
    if (this._disconnected) throw new Error("Session disconnected");
    this.messages.push({ prompt: opts.prompt, timestamp: Date.now() });
    this.emit("message.received", opts.prompt);
  }

  async sendAndWait(
    opts: { prompt: string },
    _timeout?: number,
  ): Promise<{ data: { content: string } } | undefined> {
    await this.send(opts);
    return { data: { content: `[mock response to: ${opts.prompt.slice(0, 50)}]` } };
  }

  async disconnect(): Promise<void> {
    this._disconnected = true;
  }

  async abort(): Promise<void> {}

  async getMessages(): Promise<any[]> {
    return this.messages;
  }

  get isDisconnected(): boolean {
    return this._disconnected;
  }

  /** Get the last message sent to this session */
  get lastMessage(): string | undefined {
    return this.messages[this.messages.length - 1]?.prompt;
  }

  /** Check if any message contains the given substring */
  hasMessageContaining(text: string): boolean {
    return this.messages.some((m) => m.prompt.includes(text));
  }

  /** Get all messages containing the given substring */
  messagesContaining(text: string): string[] {
    return this.messages.filter((m) => m.prompt.includes(text)).map((m) => m.prompt);
  }

  /** Clear recorded messages */
  clearMessages(): void {
    this.messages.length = 0;
  }
}

/**
 * Mock CopilotClient for testing.
 * Creates MockCopilotSessions instead of real SDK sessions.
 */
export class MockCopilotClient {
  private _started = false;
  readonly createdSessions: MockCopilotSession[] = [];
  readonly resumedSessions: Map<string, MockCopilotSession> = new Map();

  async start(): Promise<void> {
    this._started = true;
  }

  async stop(): Promise<void> {
    this._started = false;
  }

  get isStarted(): boolean {
    return this._started;
  }

  async createSession(config: {
    model?: string;
    tools?: any[];
    systemMessage?: any;
    workingDirectory?: string;
    onPermissionRequest?: any;
  }): Promise<MockCopilotSession> {
    if (!this._started) throw new Error("Client not started");
    const session = new MockCopilotSession();
    this.createdSessions.push(session);
    return session;
  }

  async resumeSession(
    sessionId: string,
    _config: any,
  ): Promise<MockCopilotSession> {
    if (!this._started) throw new Error("Client not started");
    const session = new MockCopilotSession(sessionId);
    this.resumedSessions.set(sessionId, session);
    return session;
  }

  async listSessions(): Promise<Array<{ sessionId: string }>> {
    return this.createdSessions.map((s) => ({ sessionId: s.sessionId }));
  }

  async deleteSession(_sessionId: string): Promise<void> {}
}
