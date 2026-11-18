import type { AppSyncIdentityCognito, AppSyncResolverEvent } from 'aws-lambda';
import { type CaseService } from './service';
import { DomainError, type Role, ROLES, type User } from './domain/types';

type Args = Record<string, any>;  // eslint-disable-line @typescript-eslint/no-explicit-any
type Resolver = (svc: CaseService, user: User, a: Args) => Promise<unknown>;

/** One entry per GraphQL field; AppSync routes every field to this Lambda. */
export const RESOLVERS: Record<string, Resolver> = {
  'Query.me': (s, u) => s.me(u),
  'Query.staff': (s, u) => s.users(u),
  'Query.cases': (s, u, a) => s.listCases(u, a.filter ?? {}),
  'Query.case': (s, u, a) => s.getCase(u, a.id),
  'Query.dashboard': (s, u) => s.dashboard(u),
  'Query.auditLog': (s, u, a) => s.auditLog(u, a),
  'Mutation.createCase': (s, u, a) => s.createCase(u, a.input),
  'Mutation.advanceStep': (s, u, a) => s.advanceStep(u, a.caseId, a.expectedVersion, a.note),
  'Mutation.setStatus': (s, u, a) => s.setStatus(u, a.caseId, a.expectedVersion, a.status, a.reason),
  'Mutation.addNote': (s, u, a) => s.addNote(u, a.caseId, a.kind, a.text),
  'Mutation.recordRefillCheckIn': (s, u, a) => s.recordRefillCheckIn(u, a.caseId, a.note),
  'Mutation.assignCase': (s, u, a) => s.assignCase(u, a.caseId, a.ownerId ?? null),
  'Mutation.addTask': (s, u, a) => s.addTask(u, a.caseId, a.title, a.dueAt, a.assigneeId),
  'Mutation.completeTask': (s, u, a) => s.completeTask(u, a.caseId, a.taskId),
  'Mutation.draftNextAction': (s, u, a) => s.draftNextAction(u, a.caseId),
  'Mutation.acceptDraft': (s, u, a) => s.acceptDraft(u, a.caseId, a.title, a.dueInDays, a.rationale),
};

/** Group precedence when a user is in several Cognito groups: the most privileged wins. */
const GROUP_PRECEDENCE: Role[] = ['SUPERVISOR', 'CASE_MANAGER', 'INTAKE_COORDINATOR', 'COMPLIANCE_AUDITOR'];

/** Maps the Cognito identity AppSync passes in to a staff user. No group means no access. */
export function userFromIdentity(identity: AppSyncResolverEvent<Args>['identity']): User {
  const id = identity as AppSyncIdentityCognito | null | undefined;
  if (!id?.sub) throw new DomainError('FORBIDDEN', 'Not signed in');
  const groups = (id.groups ?? []).filter((g): g is Role => (ROLES as readonly string[]).includes(g));
  const role = GROUP_PRECEDENCE.find((r) => groups.includes(r));
  if (!role) throw new DomainError('FORBIDDEN', 'Your account has no role assigned');
  const claims = id.claims as Record<string, unknown> | undefined;
  const name = (claims?.name as string | undefined) ?? (claims?.email as string | undefined) ?? id.username;
  return { id: id.sub, name, role };
}

export class ResolverError extends Error {
  constructor(readonly errorType: string, message: string) {
    super(message);
    this.name = errorType;  // AppSync reports a Lambda error's name as the GraphQL errorType
  }
}

export async function handle(svc: CaseService, event: AppSyncResolverEvent<Args>): Promise<unknown> {
  const key = `${event.info.parentTypeName}.${event.info.fieldName}`;
  const resolver = RESOLVERS[key];
  if (!resolver) throw new ResolverError('NotImplemented', `No resolver for ${key}`);
  try {
    return await resolver(svc, userFromIdentity(event.identity), event.arguments ?? {});
  } catch (err) {
    if (err instanceof DomainError) throw new ResolverError(err.code, err.message);
    console.error(JSON.stringify({ msg: 'resolver failed', field: key, error: String(err) }));  // no arguments: they may contain patient data
    throw new ResolverError('InternalError', 'Something went wrong');
  }
}
