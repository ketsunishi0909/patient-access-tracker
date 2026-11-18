// The same behavioral contract for both stores. The DynamoDB run needs DynamoDB Local:
//   docker run -p 8000:8000 amazon/dynamodb-local
//   DYNAMODB_ENDPOINT=http://localhost:8000 npm test
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { DynamoRepository } from '../src/data/dynamo';
import { MemoryRepository } from '../src/data/memory';
import type { Repository } from '../src/data/repository';
import type { AuditEvent } from '../src/domain/types';
import { caseMeta, manager, manager2, NOW } from './helpers';

const endpoint = process.env.DYNAMODB_ENDPOINT;

async function dynamoRepo(): Promise<Repository> {
  const client = new DynamoDBClient({ endpoint, region: 'local', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
  const suffix = Math.random().toString(36).slice(2, 8);
  const cases = `cases-${suffix}`, audit = `audit-${suffix}`;
  const S = (n: string) => ({ AttributeName: n, AttributeType: 'S' as const });
  const key = (h: string, r: string) => [{ AttributeName: h, KeyType: 'HASH' as const }, { AttributeName: r, KeyType: 'RANGE' as const }];
  // Mirrors infra/dynamodb.tf.
  await client.send(new CreateTableCommand({
    TableName: cases, BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK'].map(S), KeySchema: key('PK', 'SK'),
    GlobalSecondaryIndexes: [
      { IndexName: 'GSI1', KeySchema: key('GSI1PK', 'GSI1SK'), Projection: { ProjectionType: 'ALL' } },
      { IndexName: 'GSI2', KeySchema: key('GSI2PK', 'GSI2SK'), Projection: { ProjectionType: 'ALL' } },
    ],
  }));
  await client.send(new CreateTableCommand({
    TableName: audit, BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: ['PK', 'SK', 'caseKey'].map(S), KeySchema: key('PK', 'SK'),
    GlobalSecondaryIndexes: [{ IndexName: 'ByCase', KeySchema: key('caseKey', 'SK'), Projection: { ProjectionType: 'ALL' } }],
  }));
  return new DynamoRepository({ cases, audit }, client);
}

const stores: [string, () => Promise<Repository>, boolean][] = [
  ['MemoryRepository', async () => new MemoryRepository(), true],
  ['DynamoRepository', dynamoRepo, Boolean(endpoint)],
];

for (const [name, make, enabled] of stores) {
  describe.skipIf(!enabled)(`${name} contract`, () => {
    it('round-trips a case with its events and tasks in one read', async () => {
      const repo = await make();
      const meta = caseMeta();
      await repo.save({
        meta, expectedVersion: null,
        events: [{ id: 'e1', caseId: meta.id, at: NOW.toISOString(), actorId: manager.id, type: 'NOTE', summary: 'hello' }],
        tasks: [{ id: 't1', caseId: meta.id, title: 'Call payer', dueAt: NOW.toISOString(), assigneeId: manager.id,
                  status: 'OPEN', source: 'MANUAL', createdAt: NOW.toISOString(), completedAt: null }],
      });
      const rec = await repo.getCase(meta.id);
      expect(rec?.meta).toEqual(meta);
      expect(rec?.events.map((e) => e.summary)).toEqual(['hello']);
      expect(rec?.tasks.map((t) => t.title)).toEqual(['Call payer']);
      expect(await repo.getCase('CASE-NOPE')).toBeNull();
    });

    it('enforces create-once and optimistic version checks atomically', async () => {
      const repo = await make();
      const meta = caseMeta();
      await repo.save({ meta, expectedVersion: null });
      await expect(repo.save({ meta, expectedVersion: null })).rejects.toMatchObject({ code: 'CONFLICT' });
      await repo.save({ meta: { ...meta, version: 4 }, expectedVersion: 3 });
      // A stale write fails and its event must not be stored either.
      await expect(repo.save({
        meta: { ...meta, version: 5 }, expectedVersion: 3,
        events: [{ id: 'stale', caseId: meta.id, at: NOW.toISOString(), actorId: manager.id, type: 'NOTE', summary: 'stale' }],
      })).rejects.toMatchObject({ code: 'CONFLICT' });
      const rec = await repo.getCase(meta.id);
      expect(rec?.meta.version).toBe(4);
      expect(rec?.events).toHaveLength(0);
    });

    it('lists cases by status and by owner', async () => {
      const repo = await make();
      await repo.save({ meta: caseMeta({ id: 'C1', ownerId: manager.id }), expectedVersion: null });
      await repo.save({ meta: caseMeta({ id: 'C2', ownerId: manager2.id }), expectedVersion: null });
      await repo.save({ meta: caseMeta({ id: 'C3', ownerId: manager.id, status: 'COMPLETED' }), expectedVersion: null });
      expect((await repo.listCases({ statuses: ['ACTIVE'] })).map((c) => c.id).sort()).toEqual(['C1', 'C2']);
      expect((await repo.listCases({ statuses: ['ACTIVE', 'COMPLETED'], ownerId: manager.id })).map((c) => c.id).sort()).toEqual(['C1', 'C3']);
      // Ownership changes move the case between owner partitions.
      const c2 = (await repo.getCase('C2'))!.meta;
      await repo.save({ meta: { ...c2, ownerId: manager.id, version: c2.version + 1 }, expectedVersion: c2.version });
      expect((await repo.listCases({ statuses: ['ACTIVE'], ownerId: manager2.id }))).toHaveLength(0);
    });

    it('pages the audit log newest first and filters by case', async () => {
      const repo = await make();
      const ev = (i: number, caseIds: string[]): AuditEvent => ({
        id: `a${i}`, at: new Date(NOW.getTime() - i * 60_000).toISOString(), actorId: manager.id, actorName: manager.name,
        actorRole: manager.role, action: 'VIEW_CASE', outcome: 'ALLOWED', caseIds, detail: '',
      });
      for (let i = 0; i < 7; i++) await repo.appendAudit(ev(i, [i % 2 ? 'C-ODD' : 'C-EVEN']));
      const p1 = await repo.listAudit({ limit: 3 });
      expect(p1.items.map((e) => e.id)).toEqual(['a0', 'a1', 'a2']);
      const p2 = await repo.listAudit({ limit: 3, nextToken: p1.nextToken });
      expect(p2.items.map((e) => e.id)).toEqual(['a3', 'a4', 'a5']);
      expect((await repo.listAudit({ caseId: 'C-ODD', limit: 10 })).items.map((e) => e.id)).toEqual(['a1', 'a3', 'a5']);
    });
  });
}
