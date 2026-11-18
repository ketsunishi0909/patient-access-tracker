variable "project" {
  description = "Name prefix for all resources."
  type        = string
  default     = "pat-tracker"
}

variable "region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "enable_claude" {
  description = "Create a Secrets Manager secret for the Anthropic API key and let the drafter call Claude. When false, drafts come from the rules engine only."
  type        = bool
  default     = true
}

variable "model_id" {
  description = "Claude model used by the next-action drafter."
  type        = string
  default     = "claude-opus-5-5"
}

variable "extra_callback_urls" {
  description = "Additional OAuth callback URLs for the web app, e.g. http://localhost:5173/ for development against the deployed API."
  type        = list(string)
  default     = []
}

variable "log_retention_days" {
  description = "CloudWatch log retention."
  type        = number
  default     = 90
}
