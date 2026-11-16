import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { QueueMessage } from '@dailytasks/database';

export interface ReceivedMessage {
  body: QueueMessage;
  receiptHandle: string;
  receiveCount: number;
}

export interface Queue {
  send(message: QueueMessage): Promise<void>;
  receive(maxMessages: number, waitSeconds: number): Promise<ReceivedMessage[]>;
  ack(receiptHandle: string): Promise<void>;
}

/** SQS standard queue. Retries come from the visibility timeout; poison messages go to the DLQ (redrive policy). */
export class SqsQueue implements Queue {
  private readonly client: SQSClient;
  constructor(
    private readonly queueUrl: string,
    region: string,
    endpoint?: string,
  ) {
    this.client = new SQSClient({ region, endpoint });
  }

  async send(message: QueueMessage) {
    await this.client.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(message) }));
  }

  async receive(maxMessages: number, waitSeconds: number): Promise<ReceivedMessage[]> {
    const res = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: maxMessages,
        WaitTimeSeconds: waitSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    const out: ReceivedMessage[] = [];
    for (const m of res.Messages ?? []) {
      let body: QueueMessage;
      try {
        body = JSON.parse(m.Body ?? '');
      } catch {
        // Unparseable: acknowledge so it does not loop forever (it would only ever fail).
        await this.ack(m.ReceiptHandle!);
        continue;
      }
      out.push({ body, receiptHandle: m.ReceiptHandle!, receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? 1) });
    }
    return out;
  }

  async ack(receiptHandle: string) {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle }));
  }
}

/** In-memory queue for tests. */
export class MemoryQueue implements Queue {
  messages: QueueMessage[] = [];
  async send(message: QueueMessage) {
    this.messages.push(message);
  }
  async receive(max: number): Promise<ReceivedMessage[]> {
    return this.messages.splice(0, max).map((body, i) => ({ body, receiptHandle: `${Date.now()}-${i}`, receiveCount: 1 }));
  }
  async ack() {}
}
