# Build the bundle first: `npm run build -w backend` (writes backend/dist/lambda.mjs).
data "archive_file" "api" {
  type        = "zip"
  source_file = "${path.module}/../backend/dist/lambda.mjs"
  output_path = "${path.module}/.build/api.zip"
}

resource "aws_secretsmanager_secret" "anthropic" {
  count       = var.enable_claude ? 1 : 0
  name        = "${local.name}/anthropic-api-key"
  description = "Anthropic API key for the next-action drafter. Set the value outside Terraform so it never lands in state."
  kms_key_id  = aws_kms_key.main.arn
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.name}-api"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.main.arn
}

resource "aws_iam_role" "api" {
  name = "${local.name}-api"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "api" {
  name = "least-privilege"
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Sid      = "Logs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.api.arn}:*"
      },
      {
        Sid      = "Tracing"
        Effect   = "Allow"
        Action   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
        Resource = "*"
      },
      {
        Sid      = "Cases"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:ConditionCheckItem"]
        Resource = [aws_dynamodb_table.cases.arn, "${aws_dynamodb_table.cases.arn}/index/*"]
      },
      {
        # Append-only: no UpdateItem, DeleteItem or BatchWriteItem on the audit table.
        Sid      = "AuditAppendOnly"
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:Query"]
        Resource = [aws_dynamodb_table.audit.arn, "${aws_dynamodb_table.audit.arn}/index/*"]
      },
      {
        Sid      = "Kms"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
        Resource = aws_kms_key.main.arn
      },
      ], var.enable_claude ? [{
        Sid      = "AnthropicKey"
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = aws_secretsmanager_secret.anthropic[0].arn
    }] : [])
  })
}

resource "aws_lambda_function" "api" {
  function_name    = "${local.name}-api"
  role             = aws_iam_role.api.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "lambda.handler"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  memory_size      = 512
  timeout          = 30
  kms_key_arn      = aws_kms_key.main.arn

  environment {
    variables = {
      CASES_TABLE          = aws_dynamodb_table.cases.name
      AUDIT_TABLE          = aws_dynamodb_table.audit.name
      AGENT_MODE           = var.enable_claude ? "claude" : "rules"
      ANTHROPIC_SECRET_ARN = var.enable_claude ? aws_secretsmanager_secret.anthropic[0].arn : ""
      MODEL_ID             = var.model_id
    }
  }

  tracing_config {
    mode = "Active"
  }

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.api.name
  }

  depends_on = [aws_iam_role_policy.api]
}
