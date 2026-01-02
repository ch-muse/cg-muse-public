import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { workflowSchemaZod, type WorkflowSchema } from "./workflowSchema.zod.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WORKFLOW_SCHEMA_ROOT = path.resolve(__dirname, "../../..", "data", "comfy", "schemas", "v1");

type WorkflowSchemaErrorOptions = {
  filePath?: string;
  issues?: z.ZodIssue[];
};

class WorkflowSchemaError extends Error {
  readonly filePath?: string;
  readonly issues?: z.ZodIssue[];

  constructor(message: string, options: WorkflowSchemaErrorOptions = {}) {
    super(message);
    this.name = "WorkflowSchemaError";
    this.filePath = options.filePath;
    this.issues = options.issues;
  }
}

const formatZodIssues = (issues: z.ZodIssue[]) =>
  issues
    .map((issue) => {
      const pathLabel = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${pathLabel}: ${issue.message}`;
    })
    .join("; ");

const validateWorkflowSchema = (payload: unknown, source?: string): WorkflowSchema => {
  const parsed = workflowSchemaZod.safeParse(payload);
  if (!parsed.success) {
    const details = formatZodIssues(parsed.error.issues);
    const suffix = source ? ` (${source})` : "";
    const message = details ? `Invalid workflow schema${suffix}: ${details}` : `Invalid workflow schema${suffix}`;
    throw new WorkflowSchemaError(message, { filePath: source, issues: parsed.error.issues });
  }
  return parsed.data;
};

const resolveWorkflowSchemaPath = (schemaId: string, root = WORKFLOW_SCHEMA_ROOT) =>
  path.join(root, `${schemaId}.schema.json`);

const readWorkflowSchemaFile = async (filePath: string): Promise<WorkflowSchema> => {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : "read_failed";
    throw new WorkflowSchemaError(`Workflow schema not found: ${filePath} (${detail})`, { filePath });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "invalid_json";
    throw new WorkflowSchemaError(`Workflow schema is not valid JSON: ${filePath} (${detail})`, { filePath });
  }

  return validateWorkflowSchema(parsed, filePath);
};

const loadWorkflowSchema = async (schemaId: string, root = WORKFLOW_SCHEMA_ROOT): Promise<WorkflowSchema> => {
  const filePath = resolveWorkflowSchemaPath(schemaId, root);
  return readWorkflowSchemaFile(filePath);
};

export {
  WORKFLOW_SCHEMA_ROOT,
  WorkflowSchemaError,
  validateWorkflowSchema,
  resolveWorkflowSchemaPath,
  readWorkflowSchemaFile,
  loadWorkflowSchema
};
