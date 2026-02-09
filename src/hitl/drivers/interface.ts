export interface HitlRequest {
  id: string;
  agent?: string;
  mcpName: string;
  toolName: string;
  params: Record<string, unknown>;
  reason?: string;
  content?: string;
  timeout: number;
}

export type HitlDecision = 'approved' | 'rejected' | 'timeout';

export interface HitlResponse {
  decision: HitlDecision;
  decidedBy: string;
}

export interface MessageUpdate {
  decision: HitlDecision;
  decidedBy: string;
  elapsed?: number;
}

export interface HitlDriver {
  sendRequest(request: HitlRequest): Promise<string>;
  updateMessage(messageId: string, update: MessageUpdate): Promise<void>;
  onResponse(callback: (messageId: string, response: HitlResponse) => void): void;
  start(): Promise<void>;
  close(): Promise<void>;
}
