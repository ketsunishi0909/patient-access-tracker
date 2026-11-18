locals {
  # Every GraphQL field resolves through the one Lambda (direct Lambda resolvers).
  # Keep in sync with RESOLVERS in backend/src/handler.ts.
  resolvers = {
    "Query.me"                     = {}, "Query.staff" = {}, "Query.cases" = {}, "Query.case" = {}, "Query.dashboard" = {}, "Query.auditLog" = {},
    "Mutation.createCase"          = {}, "Mutation.advanceStep" = {}, "Mutation.setStatus" = {}, "Mutation.addNote" = {},
    "Mutation.recordRefillCheckIn" = {}, "Mutation.assignCase" = {}, "Mutation.addTask" = {}, "Mutation.completeTask" = {},
    "Mutation.draftNextAction"     = {}, "Mutation.acceptDraft" = {},
  }
}

resource "aws_iam_role" "appsync_logs" {
  name = "${local.name}-appsync-logs"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "appsync.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "appsync_logs" {
  role       = aws_iam_role.appsync_logs.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSAppSyncPushToCloudWatchLogs"
}

resource "aws_appsync_graphql_api" "api" {
  name                 = "${local.name}-api"
  authentication_type  = "AMAZON_COGNITO_USER_POOLS"
  schema               = file("${path.module}/../schema/schema.graphql")
  xray_enabled         = true
  introspection_config = "DISABLED"
  query_depth_limit    = 8

  user_pool_config {
    user_pool_id   = aws_cognito_user_pool.staff.id
    aws_region     = local.region
    default_action = "ALLOW"
  }

  # Errors only, and never request/response bodies: they could contain patient fields.
  log_config {
    cloudwatch_logs_role_arn = aws_iam_role.appsync_logs.arn
    field_log_level          = "ERROR"
    exclude_verbose_content  = true
  }
}

resource "aws_iam_role" "appsync_invoke" {
  name = "${local.name}-appsync-invoke"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "appsync.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "appsync_invoke" {
  role = aws_iam_role.appsync_invoke.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "lambda:InvokeFunction", Resource = aws_lambda_function.api.arn }]
  })
}

resource "aws_appsync_datasource" "api" {
  api_id           = aws_appsync_graphql_api.api.id
  name             = "CaseApi"
  type             = "AWS_LAMBDA"
  service_role_arn = aws_iam_role.appsync_invoke.arn
  lambda_config {
    function_arn = aws_lambda_function.api.arn
  }
}

resource "aws_appsync_resolver" "fields" {
  for_each    = local.resolvers
  api_id      = aws_appsync_graphql_api.api.id
  type        = split(".", each.key)[0]
  field       = split(".", each.key)[1]
  data_source = aws_appsync_datasource.api.name
  kind        = "UNIT"
}
