locals {
  roles = {
    SUPERVISOR         = { precedence = 1, description = "Sees all cases and protected fields, reassigns cases, reads the audit log" }
    CASE_MANAGER       = { precedence = 2, description = "Works their own cases; sees other cases with protected fields masked" }
    INTAKE_COORDINATOR = { precedence = 3, description = "Opens cases; works their own and unassigned cases" }
    COMPLIANCE_AUDITOR = { precedence = 4, description = "Reads the audit log; sees cases with patient details masked; no edits" }
  }
  callback_urls = concat(["https://${aws_cloudfront_distribution.web.domain_name}/"], var.extra_callback_urls)
}

resource "aws_cognito_user_pool" "staff" {
  name                     = "${local.name}-staff"
  deletion_protection      = "ACTIVE"
  mfa_configuration        = "ON"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  # Staff accounts are provisioned by an administrator; no self sign-up.
  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  software_token_mfa_configuration {
    enabled = true
  }

  password_policy {
    minimum_length                   = 14
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 3
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  schema {
    name                = "name"
    attribute_data_type = "String"
    required            = true
    mutable             = true
    string_attribute_constraints {
      min_length = 1
      max_length = 100
    }
  }
}

resource "aws_cognito_user_group" "roles" {
  for_each     = local.roles
  name         = each.key
  user_pool_id = aws_cognito_user_pool.staff.id
  precedence   = each.value.precedence
  description  = each.value.description
}

resource "aws_cognito_user_pool_domain" "staff" {
  domain       = local.name
  user_pool_id = aws_cognito_user_pool.staff.id
}

# Public SPA client: authorization code + PKCE, no client secret.
resource "aws_cognito_user_pool_client" "web" {
  name                                 = "${local.name}-web"
  user_pool_id                         = aws_cognito_user_pool.staff.id
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = local.callback_urls
  logout_urls                          = local.callback_urls
  explicit_auth_flows                  = ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"]
  prevent_user_existence_errors        = "ENABLED"
  enable_token_revocation              = true

  id_token_validity      = 60
  access_token_validity  = 60
  refresh_token_validity = 8
  token_validity_units {
    id_token      = "minutes"
    access_token  = "minutes"
    refresh_token = "hours"
  }
}
