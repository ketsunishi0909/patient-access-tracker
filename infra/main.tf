terraform {
  required_version = ">= 1.6"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.4" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # Configure a remote backend (S3 + DynamoDB lock table) before using this for anything shared.
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project   = var.project
      DataClass = "synthetic-only"
      ManagedBy = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

resource "random_id" "suffix" {
  byte_length = 3
}

locals {
  name   = "${var.project}-${random_id.suffix.hex}"
  region = data.aws_region.current.region
}

# One customer-managed key for the tables, the API key secret and the logs.
resource "aws_kms_key" "main" {
  description         = "${local.name} data encryption"
  enable_key_rotation = true
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountAdmin"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "CloudWatchLogs"
        Effect    = "Allow"
        Principal = { Service = "logs.${local.region}.amazonaws.com" }
        Action    = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
        Resource  = "*"
        Condition = {
          ArnLike = { "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${local.region}:${data.aws_caller_identity.current.account_id}:*" }
        }
      },
    ]
  })
}

resource "aws_kms_alias" "main" {
  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.main.key_id
}
