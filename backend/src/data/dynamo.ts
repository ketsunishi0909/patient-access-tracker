import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, type QueryCommandInput, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { type AuditEvent, type CaseEvent, type CaseMeta, type CaseRecord, type CaseStatus, DomainError, type Task, type User } from '../domain/types';
import type { AuditPage, CaseChanges, Repository } from './repository';

/*
 * Single-table design for cases (table `casesTable`):
 *
 *   item        PK              SK                      GSI1 (by owner)           GSI2 (by status)
 *   case        CASE#<id>       META                    OWNER#<owner>|<id>        STATUS#<status>|<stepEnteredAt>#<id>
 *   event       CASE#<id>       EVENT#<at>#<eventId>
 *   task        CASE#<id>       TASK#<taskId>
 *   staff       STAFF           USER#<userId>
 *
 * Opening a case is one Query on PK = CASE#<id> (record, timeline and tasks together).
 *
 * The audit log lives in its own table (`auditTable`) so IAM can grant the
 * Lambda PutItem and Query on it and nothing else: entries cannot be changed or deleted.
 *
 *   PK = MONTH#<yyyy-mm>, SK = <at>#<id>; GSI ByCase: caseKey = CASE#<id> (single-case events only)
 */

const AUDIT_MONTHS_BACK = 24;

type Item = Record<string, unknown>;

function strip<T>(item: Item, ...extra: string[]): T {
  const out: Item = { ...item };
  for (const k of ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK', 'entity', 'caseKey', ...extra]) delete out[k];
  return out as T;
}

export class DynamoRepository implements Repository {
  private readonly db: DynamoDBDocumentClient;

  constructor(private readonly tables: { cases: string; audit: string }, client = new DynamoDBClient({})) {
    this.db = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  async getCase(id: string): Promise<CaseRecord | null> {
    const items = await this.queryAll({
      TableName: this.tables.cases,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `CASE#${id}` },
      ConsistentRead: true,
    });
    const meta = items.find((i) => i.SK === 'META');
    if (!meta) return null;
    return {
      meta: strip<CaseMeta>(meta),
      events: items.filter((i) => String(i.SK).startsWith('EVENT#')).map((i) => strip<CaseEvent>(i)),
      tasks: items.filter((i) => String(i.SK).startsWith('TASK#')).map((i) => strip<Task>(i)),
    };
  }

  async listCases(opts: { statuses: CaseStatus[]; ownerId?: string }): Promise<CaseMeta[]> {
    if (opts.ownerId !== undefined) {
      const items = await this.queryAll({
        TableName: this.tables.cases,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': `OWNER#${opts.ownerId}` },
      });
      return items.map((i) => strip<CaseMeta>(i)).filter((c) => opts.statuses.includes(c.status));
    }
    const lists = await Promise.all(opts.statuses.map((s) => this.queryAll({
      TableName: this.tables.cases,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': `STATUS#${s}` },
    })));
    return lists.flat().map((i) => strip<CaseMeta>(i));
  }

  async save(ch: CaseChanges): Promise<void> {
    const ops: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']> = [];
    if (ch.meta) {
      const m = ch.meta;
      const put: Record<string, unknown> = {
        TableName: this.tables.cases,
        Item: {
          ...m,
          PK: `CASE#${m.id}`, SK: 'META', entity: 'CASE',
          GSI1PK: `OWNER#${m.ownerId ?? 'UNASSIGNED'}`, GSI1SK: m.id,
          GSI2PK: `STATUS#${m.status}`, GSI2SK: `${m.stepEnteredAt}#${m.id}`,
        },
      };
      if (ch.expectedVersion === null) {
        put.ConditionExpression = 'attribute_not_exists(PK)';
      } else if (typeof ch.expectedVersion === 'number') {
        put.ConditionExpression = '#v = :v';
        put.ExpressionAttributeNames = { '#v': 'version' };
        put.ExpressionAttributeValues = { ':v': ch.expectedVersion };
      }
      ops.push({ Put: put as never });
    }
    for (const e of ch.events ?? []) {
      ops.push({ Put: {
        TableName: this.tables.cases,
        Item: { ...e, PK: `CASE#${e.caseId}`, SK: `EVENT#${e.at}#${e.id}`, entity: 'EVENT' },
        ConditionExpression: 'attribute_not_exists(PK)',
      } });
    }
    for (const t of ch.tasks ?? []) {
      ops.push({ Put: { TableName: this.tables.cases, Item: { ...t, PK: `CASE#${t.caseId}`, SK: `TASK#${t.id}`, entity: 'TASK' } } });
    }
    if (ops.length === 0) return;
    if (ops.length > 100) throw new DomainError('INVALID', 'Too many changes in one write');
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: ops }));
    } catch (err) {
      if (err instanceof TransactionCanceledException && err.CancellationReasons?.some((r) => r.Code === 'ConditionalCheckFailed')) {
        throw new DomainError('CONFLICT', `Case ${ch.meta?.id ?? ''} was changed by someone else; reload and try again`);
      }
      throw err;
    }
  }

  async upsertUser(user: User): Promise<void> {
    await this.db.send(new PutCommand({
      TableName: this.tables.cases,
      Item: { ...user, PK: 'STAFF', SK: `USER#${user.id}`, entity: 'USER' },
    }));
  }

  async listUsers(): Promise<User[]> {
    const items = await this.queryAll({
      TableName: this.tables.cases,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': 'STAFF' },
    });
    return items.map((i) => strip<User>(i)).sort((a, b) => a.name.localeCompare(b.name));
  }

  async appendAudit(e: AuditEvent): Promise<void> {
    await this.db.send(new PutCommand({
      TableName: this.tables.audit,
      Item: {
        ...e,
        PK: `MONTH#${e.at.slice(0, 7)}`,
        SK: `${e.at}#${e.id}`,
        ...(e.caseIds.length === 1 ? { caseKey: `CASE#${e.caseIds[0]}` } : {}),
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  }

  async listAudit(opts: { caseId?: string; limit: number; nextToken?: string | null }): Promise<AuditPage> {
    const token = opts.nextToken ? JSON.parse(Buffer.from(opts.nextToken, 'base64url').toString()) as { month?: string; key?: Item } : {};
    if (opts.caseId) {
      const res = await this.db.send(new QueryCommand({
        TableName: this.tables.audit,
        IndexName: 'ByCase',
        KeyConditionExpression: 'caseKey = :ck',
        ExpressionAttributeValues: { ':ck': `CASE#${opts.caseId}` },
        ScanIndexForward: false,
        Limit: opts.limit,
        ExclusiveStartKey: token.key,
      }));
      return {
        items: (res.Items ?? []).map((i) => strip<AuditEvent>(i)),
        nextToken: res.LastEvaluatedKey ? encode({ key: res.LastEvaluatedKey }) : null,
      };
    }
    // Newest first, walking back one month partition at a time.
    const items: AuditEvent[] = [];
    let month = token.month ?? new Date().toISOString().slice(0, 7);
    let key = token.key;
    for (let i = 0; i < AUDIT_MONTHS_BACK && items.length < opts.limit; i++) {
      const res = await this.db.send(new QueryCommand({
        TableName: this.tables.audit,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `MONTH#${month}` },
        ScanIndexForward: false,
        Limit: opts.limit - items.length,
        ExclusiveStartKey: key,
      }));
      items.push(...(res.Items ?? []).map((it) => strip<AuditEvent>(it)));
      if (res.LastEvaluatedKey) {
        if (items.length >= opts.limit) return { items, nextToken: encode({ month, key: res.LastEvaluatedKey }) };
        key = res.LastEvaluatedKey;
        i--;  // same month still has more
        continue;
      }
      key = undefined;
      month = previousMonth(month);
    }
    return { items, nextToken: items.length >= opts.limit ? encode({ month }) : null };
  }

  private async queryAll(input: QueryCommandInput): Promise<Item[]> {
    const out: Item[] = [];
    let key: Item | undefined;
    do {
      const res = await this.db.send(new QueryCommand({ ...input, ExclusiveStartKey: key }));
      out.push(...(res.Items ?? []));
      key = res.LastEvaluatedKey;
    } while (key);
    return out;
  }
}

function encode(v: unknown): string {
  return Buffer.from(JSON.stringify(v)).toString('base64url');
}

function previousMonth(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 2, 1));
  return d.toISOString().slice(0, 7);
}
