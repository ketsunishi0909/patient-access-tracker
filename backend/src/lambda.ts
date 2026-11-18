// AWS Lambda entry point: AppSync direct Lambda resolver for every field.
import Anthropic from '@anthropic-ai/sdk';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { AppSyncResolverEvent } from 'aws-lambda';
import { ClaudeDrafter, type Drafter, FallbackDrafter, RulesDrafter } from './agent/drafter';
import { DynamoRepository } from './data/dynamo';
import { handle } from './handler';
import { CaseService } from './service';

let service: Promise<CaseService> | null = null;

async function makeDrafter(): Promise<Drafter> {
  const secretArn = process.env.ANTHROPIC_SECRET_ARN;
  if (process.env.AGENT_MODE === 'rules' || !secretArn) return new RulesDrafter();
  const secret = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!secret.SecretString) return new RulesDrafter();
  // AppSync gives a resolver 30 s in total, so the model call must give up first and fall back to rules.
  const client = new Anthropic({ apiKey: secret.SecretString, timeout: 22_000, maxRetries: 0 });
  return new FallbackDrafter(new ClaudeDrafter(client, process.env.MODEL_ID || undefined),
    (err) => console.warn(JSON.stringify({ msg: 'draft fell back to rules', error: String(err) })));
}

async function init(): Promise<CaseService> {
  const cases = process.env.CASES_TABLE, audit = process.env.AUDIT_TABLE;
  if (!cases || !audit) throw new Error('CASES_TABLE and AUDIT_TABLE must be set');
  return new CaseService({ repo: new DynamoRepository({ cases, audit }), drafter: await makeDrafter() });
}

export async function handler(event: AppSyncResolverEvent<Record<string, unknown>>): Promise<unknown> {
  service ??= init().catch((err) => { service = null; throw err; });
  return handle(await service, event);
}
