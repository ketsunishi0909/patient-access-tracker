# Patient Access Case Tracker

Tracks patients through the steps of starting a specialty therapy: **enrollment → benefits verification → prior authorization → first fill → refill check-ins**. Every case has a status, an owner, tasks and a timeline. A dashboard flags cases that have sat at one step too long. An AI agent reads a case's history and drafts the next action, for example *"Prior authorization pending 13 days (target 7). Follow up with the prescriber's office on the PA status and any payer requests for more information."*

**All data is synthetic.** There is no real patient information anywhere in this repository or in the running system.

**Stack:** TypeScript · React · GraphQL on AWS AppSync · Lambda · DynamoDB · Cognito · Terraform · Claude (Anthropic API)

## Architecture

```
React SPA (S3 + CloudFront)
   │  Cognito sign-in (authorization code + PKCE); ID token on every request
   ▼
AppSync GraphQL API ── validates the token, passes Cognito groups to the resolver
   │  direct Lambda resolver for every field
   ▼
Lambda (Node 22, arm64)
   ├─ role-based access check ─ masking of protected fields ─ audit write
   ├─ DynamoDB  cases table (single-table: case, events, tasks, staff)
   ├─ DynamoDB  audit table (append-only: IAM allows PutItem + Query only)
   └─ Claude    next-action drafter (de-identified context, structured output)
```

One Lambda serves every GraphQL field ([backend/src/handler.ts](backend/src/handler.ts)), so access control and auditing live in one place ([backend/src/service.ts](backend/src/service.ts)). The local dev server builds the same event AppSync sends and calls the same handler, so local runs exercise the production code path.

## Domain details

**Step targets.** Each step has a target duration ([workflow.ts](backend/src/domain/workflow.ts)): enrollment 2 days, benefits verification 3, prior authorization 7, first fill 3, and a refill check-in every 30 days. A case is *at risk* at 75% of its target and *stuck* past it. On-hold cases are off the clock, and resuming restarts it.

**Role-based access** ([rbac.ts](backend/src/domain/rbac.ts)), on a minimum-necessary basis:

| | Intake coordinator | Case manager | Supervisor | Compliance auditor |
|---|---|---|---|---|
| Open cases | own + unassigned | all | all | all (masked) |
| Date of birth, member ID, phone | own cases | own cases | all | never |
| Patient name | ✓ | ✓ | ✓ | initials only |
| Edit cases, tasks, notes | own + unassigned | own + unassigned | all | no |
| Reassign cases | claim unassigned | claim unassigned | ✓ | no |
| AI next-action drafts | own cases | own cases | all | no |
| Audit log | no | no | ✓ | ✓ |

Free-text notes and call logs are hidden from anyone who can't see protected fields on that case, because staff type patient details into them.

**Audit log.**

- **What's recorded:** every read and every change, including the dashboard and case lists (all case IDs shown), each case opened (and whether protected fields were shown or masked), each AI draft (and which model produced it), and every denied attempt. Reading the audit log is itself recorded.
- **Fails closed:** the audit entry is written before data is returned, so if the write fails, the read fails too.
- **Can't be edited:** the Lambda's IAM role cannot update or delete audit entries.

**Optimistic concurrency.** Every case write is conditional on the version the user loaded, so two people can't silently overwrite each other's step changes.

**Synthetic-only guardrails.**

- Seeded member IDs use a `SYN-` prefix, and creating a case without one is rejected.
- Phone numbers are in the 555-0100–0199 range reserved for fiction.
- Therapies are invented codes such as "ZX-101 autoinjector".
- A banner on every page says the data is synthetic.

## The AI agent

[backend/src/agent/](backend/src/agent/)

1. **De-identify.** [context.ts](backend/src/agent/context.ts) builds the model's input from the case's step, days in step against target, payer, therapy, open tasks and timeline. Name, date of birth, member ID, phone numbers and the prescriber's name are never included. Free-text notes are scrubbed of them, along with any phone numbers, dates or email addresses. A test runs every seeded case through this and checks that no identifier survives. That test caught a real leak while this was being built: 7-digit phone numbers weren't being removed.
2. **Draft.** [drafter.ts](backend/src/agent/drafter.ts) calls Claude (`claude-opus-5-5`, medium effort) with structured output. The response must match a Zod schema: situation, next action, rationale, urgency, who to contact, and a suggested task. The system prompt keeps the model grounded in the recorded history and away from clinical advice. Server-side refusal fallbacks are on (`fallbacks: "default"`), so a safety decline is retried on another model within the same call.
3. **Fall back.** If no API key is configured, or the model times out, errors, declines or returns invalid output, a deterministic playbook ([rules.ts](backend/src/agent/rules.ts)) drafts the action instead, and the UI says which produced it and why.
4. **Human in the loop.** A draft changes nothing. A person edits the suggested task if needed and accepts it. The task is then marked as coming from an AI draft, and both steps are audited.

## Run it locally

Requires Node 22+. The local server uses an in-memory store seeded with 48 synthetic cases.

```bash
npm install
npm run dev            # API on :4000, web app on http://localhost:5173
```

Use the **Signed in as (demo)** menu to switch between the five staff roles. Locally, the agent uses the rules drafter unless you set a key:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run dev
```

## Tests

```bash
npm test               # 38 tests: workflow, access control, audit, de-identification, agent, GraphQL end to end
npm run typecheck
```

The repository tests in [repository.contract.test.ts](backend/test/repository.contract.test.ts) run one contract against both the in-memory store and DynamoDB. The DynamoDB half needs DynamoDB Local:

```bash
docker run -p 8000:8000 amazon/dynamodb-local
DYNAMODB_ENDPOINT=http://localhost:8000 npm test
```

## Deploy to AWS

```bash
npm run build -w backend                  # Lambda bundle -> backend/dist/lambda.mjs
cd infra && terraform init && terraform apply
aws secretsmanager put-secret-value --secret-id "$(terraform output -raw anthropic_secret_arn)" --secret-string 'sk-ant-...'
terraform output -raw frontend_env > ../frontend/.env.production
cd .. && npm run build -w frontend
aws s3 sync frontend/dist "s3://$(terraform -chdir=infra output -raw web_bucket)" --delete
```

Then create staff users in the Cognito user pool and add each one to a role group (`INTAKE_COORDINATOR`, `CASE_MANAGER`, `SUPERVISOR`, `COMPLIANCE_AUDITOR`). Users without a group are refused.

**What Terraform creates:**

- **Data:** both DynamoDB tables (point-in-time recovery, deletion protection), encrypted with a customer-managed KMS key.
- **Sign-in:** a Cognito user pool with required TOTP MFA, admin-only sign-up and the four role groups.
- **API:** AppSync with introspection off, a depth limit, and logs that record errors only (never request bodies), plus the Lambda with a least-privilege role and X-Ray tracing.
- **Secrets:** the Anthropic key in Secrets Manager. Its value is set outside Terraform, so it never lands in state.
- **Web hosting:** S3 + CloudFront with origin access control and security headers.

## Verification status

- **Verified locally:**
  - 38 backend tests.
  - Type checks and builds for backend and frontend.
  - Every page checked in a browser under all five roles.
  - `terraform validate` against AWS provider 6.73.
  - The Lambda bundle loads in Node.
- **Not yet verified:**
  - **AWS deployment.** Nothing has been applied to an AWS account, so the Cognito sign-in flow, AppSync and the DynamoDB repository have not run against real AWS services.
  - **DynamoDB contract tests.** These are written but haven't run yet: they need DynamoDB Local.
  - **Live Claude calls.** The Claude integration is tested against a mocked client (request shape, parsing, every fallback path). It has not made a live API call.
