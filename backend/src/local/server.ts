// Local development server. Serves the AppSync schema over HTTP and runs every
// field through the same handler the Lambda uses, with an in-memory store
// seeded with synthetic data. Sign-in is replaced by an `x-demo-user` header.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import type { AppSyncResolverEvent } from 'aws-lambda';
import { buildSchema, graphql, GraphQLError } from 'graphql';
import { ClaudeDrafter, type Drafter, FallbackDrafter, RulesDrafter } from '../agent/drafter';
import { MemoryRepository } from '../data/memory';
import { handle, RESOLVERS, ResolverError } from '../handler';
import { STAFF, syntheticData } from '../seed/synthetic';
import { CaseService } from '../service';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4000);
const AWS_SCALARS = 'scalar AWSDateTime\n';

export function makeDrafter(mode = process.env.AGENT_MODE ?? 'auto'): Drafter {
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (mode === 'rules' || (mode === 'auto' && !hasKey)) return new RulesDrafter();
  return new FallbackDrafter(new ClaudeDrafter(new Anthropic({ timeout: 60_000 }), process.env.MODEL_ID || undefined),
    (err) => console.warn('[agent] fell back to rules:', String(err)));
}

export async function createLocalApp(opts: { drafter?: Drafter; now?: () => Date } = {}) {
  const repo = new MemoryRepository();
  const now = opts.now ?? (() => new Date());
  const data = syntheticData(now());
  for (const u of data.staff) await repo.upsertUser(u);
  for (const c of data.cases) await repo.save({ meta: c.meta, expectedVersion: null, events: c.events, tasks: c.tasks });
  const service = new CaseService({ repo, drafter: opts.drafter ?? makeDrafter(), now });
  const schema = buildSchema(AWS_SCALARS + readFileSync(join(here, '../../../schema/schema.graphql'), 'utf8'));

  /** Root resolvers that build an AppSync-shaped event and call the Lambda handler. */
  const rootValue = Object.fromEntries(Object.keys(RESOLVERS).map((key) => {
    const [parentTypeName, fieldName] = key.split('.');
    return [fieldName, async (args: Record<string, unknown>, ctx: { userId: string | null }) => {
      const staff = STAFF.find((s) => s.id === ctx.userId);
      const event = {
        arguments: JSON.parse(JSON.stringify(args)),
        identity: staff ? { sub: staff.id, username: staff.id, groups: [staff.role], claims: { name: staff.name } } : null,
        info: { parentTypeName, fieldName },
      } as unknown as AppSyncResolverEvent<Record<string, unknown>>;
      try {
        return await handle(service, event);
      } catch (err) {
        const type = err instanceof ResolverError ? err.errorType : 'InternalError';
        throw new GraphQLError((err as Error).message, { extensions: { errorType: type } });
      }
    }];
  }));

  async function execute(body: { query: string; variables?: Record<string, unknown> }, userId: string | null) {
    const result = await graphql({ schema, source: body.query, rootValue, variableValues: body.variables, contextValue: { userId } });
    // Match AppSync's error shape: errors[].errorType.
    return {
      ...result,
      errors: result.errors?.map((e) => ({ message: e.message, path: e.path, errorType: e.extensions?.errorType ?? 'GraphQLError' })),
    };
  }

  return { execute, service, repo };
}

async function main() {
  const app = await createLocalApp();
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/graphql') {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try {
      const out = await app.execute(JSON.parse(raw), (req.headers['x-demo-user'] as string | undefined) ?? null);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' }).end('{"errors":[{"message":"Bad request"}]}');
    }
  });
  server.listen(PORT, '127.0.0.1', () => {
    const agent = process.env.AGENT_MODE === 'rules' || !(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
      ? 'rules (set ANTHROPIC_API_KEY to use Claude)' : 'Claude with rules fallback';
    console.log(`Local API on http://127.0.0.1:${PORT}/graphql (synthetic data, agent: ${agent})`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
