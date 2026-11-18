# Single-table design for cases, events, tasks and staff. See backend/src/data/dynamo.ts.
resource "aws_dynamodb_table" "cases" {
  name                        = "${local.name}-cases"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "PK"
  range_key                   = "SK"
  deletion_protection_enabled = true

  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }
  attribute {
    name = "GSI1PK"
    type = "S"
  }
  attribute {
    name = "GSI1SK"
    type = "S"
  }
  attribute {
    name = "GSI2PK"
    type = "S"
  }
  attribute {
    name = "GSI2SK"
    type = "S"
  }

  # Cases by owner.
  global_secondary_index {
    name = "GSI1"
    key_schema {
      attribute_name = "GSI1PK"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "GSI1SK"
      key_type       = "RANGE"
    }
    projection_type = "ALL"
  }

  # Cases by status, oldest step entry first (dashboard).
  global_secondary_index {
    name = "GSI2"
    key_schema {
      attribute_name = "GSI2PK"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "GSI2SK"
      key_type       = "RANGE"
    }
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.main.arn
  }
}

# Append-only audit log. The Lambda role can PutItem and Query here, nothing else.
resource "aws_dynamodb_table" "audit" {
  name                        = "${local.name}-audit"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "PK"
  range_key                   = "SK"
  deletion_protection_enabled = true

  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }
  attribute {
    name = "caseKey"
    type = "S"
  }

  global_secondary_index {
    name = "ByCase"
    key_schema {
      attribute_name = "caseKey"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "SK"
      key_type       = "RANGE"
    }
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.main.arn
  }
}
