output "graphql_url" {
  value = aws_appsync_graphql_api.api.uris["GRAPHQL"]
}

output "web_url" {
  value = "https://${aws_cloudfront_distribution.web.domain_name}/"
}

output "web_bucket" {
  value = aws_s3_bucket.web.bucket
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.web.id
}

output "user_pool_id" {
  value = aws_cognito_user_pool.staff.id
}

output "anthropic_secret_arn" {
  value = var.enable_claude ? aws_secretsmanager_secret.anthropic[0].arn : null
}

# Paste into frontend/.env.production before `npm run build -w frontend`.
output "frontend_env" {
  value = <<-EOT
    VITE_AUTH_MODE=cognito
    VITE_GRAPHQL_URL=${aws_appsync_graphql_api.api.uris["GRAPHQL"]}
    VITE_COGNITO_DOMAIN=https://${aws_cognito_user_pool_domain.staff.domain}.auth.${local.region}.amazoncognito.com
    VITE_COGNITO_CLIENT_ID=${aws_cognito_user_pool_client.web.id}
    VITE_REDIRECT_URI=https://${aws_cloudfront_distribution.web.domain_name}/
  EOT
}
